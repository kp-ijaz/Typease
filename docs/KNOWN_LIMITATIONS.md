# Known limitations

What is missing, partial, unverified or deliberately out of scope in this build of TypEase, in one place.
Every line points to the document that describes the item in detail. Nothing here is softened: if a
feature is listed, it is not there, or it has not been shown to work.

Companion document: [TEST_REPORT.md](TEST_REPORT.md) records what was executed and with what result.

## Contents

1. [How to read this document](#1-how-to-read-this-document)
2. [Not executed in the build environment](#2-not-executed-in-the-build-environment)
3. [External services requiring credentials](#3-external-services-requiring-credentials)
4. [Government integrations requiring authorisation](#4-government-integrations-requiring-authorisation)
5. [Functional gaps by area](#5-functional-gaps-by-area)
6. [Security review status](#6-security-review-status)
7. [Test-coverage gaps](#7-test-coverage-gaps)
8. [Operational items before go-live](#8-operational-items-before-go-live)
9. [Production-readiness verdict](#9-production-readiness-verdict)

## 1. How to read this document

- **The build environment** was an isolated Linux container with 2 CPU cores and 8 GB of memory, Node.js
  22, PostgreSQL 16 and Redis 7, with network access to package registries only. It had no Flutter SDK, no
  Docker daemon, no reverse proxy and no access to any external provider. Every statement of the form
  "never executed" below follows from that.
- **"Not verified"** means that no automated test and no person has observed the behaviour. The code may be
  correct; nobody has shown that it is.
- **"Operator responsibility"** means the software cannot provide the item by itself; whoever hosts it must.
- **The final verification run** behind this document took place on 13 October 2026 at commit `04c2f34`
  ("Documentation reconciliation with the final code"), in the build environment described above. Its
  records are [verification/acceptance-run.md](verification/acceptance-run.md) (the acceptance suite:
  `pnpm test:integration` 9 suites / 54 tests passed, `pnpm test:security` 6 suites / 32 tests passed,
  `pnpm --filter @typease/tests typecheck` clean, nothing re-run or skipped) and
  [verification/final-run.md](verification/final-run.md) (recorded at the time this document was
  finalised: `pnpm build:packages` passed, lint of all 16 targets with 0 errors inside the per-package
  warning budgets, every type-check passed, all package unit tests passed, the 99 API suites with 1,485
  tests passed - quoted there from the same day's `pnpm test:api` log, not re-run - `pnpm build:api`
  passed, `pnpm build:web` built all four web apps, `scripts/validate-infra.sh` 29 checks passed / 5
  skipped for missing linters, and, after a reset and re-seed, the demo-seed verification reported 59 of 59 checks - see
  TEST_REPORT.md section 2.11). Every figure in this document that depends on a run
  comes from one of those two records, not from an estimate; nothing that those records do not cover (a
  browser, the Flutter app, a container, a real provider) was run.
- The product specification is [brand/MASTER_PROMPT.md](brand/MASTER_PROMPT.md). Where this document says
  a requirement of a section of the specification is not met, it names the section.
- All names, companies and numbers in examples and in the demo data are invented
  ([DEMO_ENVIRONMENT.md](DEMO_ENVIRONMENT.md)).

## 2. Not executed in the build environment

| Component | State | What was done instead | Detail |
| --- | --- | --- | --- |
| Flutter customer app (`apps/customer-mobile`) | Source code only: about 19,400 lines of Dart under `lib/` and about 3,200 lines of tests under `test/` and `integration_test/`. **Never compiled, never run, no test executed.** The first build is development work | Read-only checks (bracket balance, unresolved imports, missing translation keys) described in its README. The README lists, most likely first, where the first compile will fail | [../apps/customer-mobile/README.md](../apps/customer-mobile/README.md), [../apps/customer-mobile/ARCHITECTURE.md](../apps/customer-mobile/ARCHITECTURE.md) |
| Docker images and Compose stacks (`infrastructure/docker`, `docker-compose.yml`, `docker-compose.prod.yml`) | Written. **No image built, no container started** | `scripts/validate-infra.sh` (`pnpm check:infra`): static validation (`docker compose config`, `bash -n`, YAML and JSON parsing). The production Dockerfiles have known build risks listed in the Docker page | [deployment/docker.md](deployment/docker.md), [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) (table at the top) |
| Reverse proxy and TLS (Caddy, on-demand certificates for custom domains) | Configuration written. **Never run; no certificate ever issued** | `caddy validate` is wired into CI (which has not run). The API side of custom domains (TXT check with a substitutable resolver, the `tls/ask` route) is tested | [deployment/reverse-proxy-and-tls.md](deployment/reverse-proxy-and-tls.md), [WHITE_LABEL_GUIDE.md](WHITE_LABEL_GUIDE.md) section 7.3 |
| CI/CD workflows (`.github/workflows/ci.yml`, `deploy.yml`, `release.yml`) | Written. **Never run.** No dependency audit (`pnpm audit`), image scan, secret scan or `actionlint` result exists | - | [deployment/ci-cd.md](deployment/ci-cd.md), [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) section 20 |
| Monitoring stack (Prometheus, Alertmanager, Loki, Alloy, Grafana) | Configuration written. **Never started**; the Grafana dashboard JSON was never loaded into a Grafana | YAML and JSON parsed | [deployment/monitoring.md](deployment/monitoring.md) |
| Object store (S3-compatible, MinIO in Compose) | The S3 storage driver was never run against a bucket; the MinIO service was never started | The local storage driver (encrypted files on disk) carried every test; S3 request building is unit-tested offline | [deployment/object-storage.md](deployment/object-storage.md), [api/modules/documents.md](api/modules/documents.md) |
| Deployment and backup scripts against a production system | `scripts/deploy.sh` exercised with `--dry-run` only; `db-backup.sh` and `db-restore.sh` drilled against the development database, never a production one; off-site upload never run | - | [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md), [security/BACKUP_AND_RECOVERY.md](security/BACKUP_AND_RECOVERY.md) |
| Browser end-to-end test suite (`tests/e2e`) | **Not written** (deliberately skipped to deliver the rest sooner). No Playwright configuration and no spec exists; `pnpm test:e2e` prints [`tests/e2e/README.md`](../tests/e2e/README.md) and **exits 1** so that it cannot be taken for a passing suite | Engineers drove every screen with the screenshot runner [`packages/ui/scripts/screenshots.mjs`](../packages/ui/scripts/screenshots.mjs) and the per-app scenario files `apps/*/scripts/shots*.mjs` (about 399 scenarios, real flows against the demo seed, pictures in `docs/brand/screenshots/`): manual verification with scripted help, not assertions in a CI sense (section 7) | [../tests/e2e/README.md](../tests/e2e/README.md) (what the scenarios cover, how to turn them into tests), [TESTING.md](TESTING.md) section 1, [TEST_REPORT.md](TEST_REPORT.md) section 2.7 |
| More than one API or worker instance, a connection pooler | Not run. Multi-instance behaviour (rate limits in Redis, resolver caches, PgBouncer transaction mode) is reasoned about, not observed | - | [deployment/scaling.md](deployment/scaling.md), [TENANT_ISOLATION.md](TENANT_ISOLATION.md) section 10 |

## 3. External services requiring credentials

Every external service is behind an adapter. Without credentials the adapter reports `NOT_CONFIGURED`
(platform console, **System status > Providers**; `GET /platform/system/providers`,
[api/modules/platform.md](api/modules/platform.md) section 1) and the feature degrades as stated below.
**None of these adapters has been exercised against the real service.** Variables are validated by
[../services/api/src/config/env.ts](../services/api/src/config/env.ts) and documented with development values
in [../.env.example](../.env.example). A centre can connect its own email, SMS, WhatsApp, push and payment
accounts under **Settings > Integrations** ([api/modules/integrations.md](api/modules/integrations.md));
those credentials are stored encrypted and are never returned by the API.

| Service | Used for | Environment variables (platform default) | Behaviour when absent | Verification status |
| --- | --- | --- | --- | --- |
| Stripe | Online payment of customer invoices (hosted checkout, webhooks, refunds); subscription invoices of the platform | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (platform); per centre `{ secretKey, webhookSecret }` in the integration row | `POST /invoices/:id/pay` answers `503 INTEGRATION_NOT_CONFIGURED`; manual payments (cash, card terminal, transfer, cheque) keep working. The `sandbox` test adapter exists only with `PAYMENT_SANDBOX_ENABLED=true`, which production refuses | Request building and `Stripe-Signature` verification unit-tested with locally computed values; every payment scenario ran against the sandbox adapter. **Stripe itself never contacted** ([api/modules/finance.md](api/modules/finance.md), "Online payments") |
| SMTP relay | Email: verification, invitations, password reset, notifications, scheduled reports | `MAIL_DRIVER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME` | `MAIL_DRIVER=log` (the default) writes the message to the application log and reports it `SENT` with provider `log`; in production a missing provider fails the delivery (`FAILED`, provider `none`) | SMTP adapter integration-tested against a real SMTP server **on localhost** (`smtp-server`), including authentication and a 451 retry. No internet mail relay contacted; SPF / DKIM / DMARC untested ([api/modules/notifications.md](api/modules/notifications.md)) |
| Twilio, or an HTTP SMS gateway | SMS: OTP sign-in, phone verification, reminders, notifications | `SMS_DRIVER=twilio` with `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`; or `SMS_DRIVER=http` with `SMS_HTTP_URL`, `SMS_HTTP_TOKEN` | As for email: logged, not delivered; in production `FAILED`. OTP sign-in and phone verification of an owner (`ONBOARDING_REQUIRE_PHONE_VERIFICATION`) are unusable without it | Local fake HTTP server asserting URL, authorisation header and body. **Twilio never contacted** |
| Meta WhatsApp Cloud API | WhatsApp notifications (template messages only) | `WHATSAPP_DRIVER=meta`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` | Logged, not delivered; in production `FAILED`. Message templates must be approved in the centre's WhatsApp business account; TypEase cannot approve them | Local fake HTTP server only. **Meta never contacted** |
| Firebase Cloud Messaging | Push notifications to the mobile app | `PUSH_DRIVER=fcm`, `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON` | Logged, not delivered; in production `FAILED` | Local fake HTTP server (OAuth JWT checked with the public key). **Google never contacted**; no device has ever registered, because the app was never run |
| S3-compatible object storage | Customer documents, generated PDFs, brand assets | `STORAGE_DRIVER=s3`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_PUBLIC_ASSETS_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, optional `S3_PUBLIC_ASSETS_BASE_URL` | `STORAGE_DRIVER=local` (the default) stores files encrypted on the API's disk and serves them through the API's own signed URLs; production start is refused when the S3 driver has no credentials | All document tests ran with the local driver. **The S3 driver was never run against a bucket**; pre-signed URL expiry and server-side encryption are therefore unverified ([deployment/object-storage.md](deployment/object-storage.md)) |
| ClamAV | Malware scan of uploads | `MALWARE_SCANNER=clamav`, `CLAMAV_HOST`, `CLAMAV_PORT`, `REQUIRE_CLEAN_SCAN` | `MALWARE_SCANNER=none` (the default): files are marked `SKIPPED` and are downloadable; only the built-in EICAR signature check runs | Adapter tested against a local fake `clamd` that asserts the INSTREAM bytes. **ClamAV never contacted** ([SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) section 13) |
| OCR provider | AI document assistant: reading passports, Emirates IDs, trade licences | `OCR_PROVIDER=tesseract` (bundled, offline, English model) or `OCR_PROVIDER=external-http` with `OCR_EXTERNAL_URL`, `OCR_EXTERNAL_TOKEN`, `OCR_COST_PER_PAGE` | `OCR_PROVIDER=disabled` (the default): `POST /documents/:id/extract` answers `503 INTEGRATION_NOT_CONFIGURED`; everything else works | Tesseract ran offline on **one synthetic specimen image** (ICAO MRZ rendered as black text on white), never on a photograph or scan; **no Arabic recognition**; no PDF input with Tesseract. `external-http` tested against a local stub only ([api/modules/ocr.md](api/modules/ocr.md) section 1) |
| n8n | Outbound automation webhooks (`call_webhook` action) | `N8N_WEBHOOK_BASE_URL`, `N8N_WEBHOOK_SECRET`, `OUTBOUND_WEBHOOK_ALLOWED_HOSTS` | A rule with a webhook action is saved with the finding `NOT_CONFIGURED` and cannot be switched on; a centre may enter the address of its own n8n (public hosts only) | Signing, SSRF guard and delivery tested against a local receiver. **No n8n instance ever called** ([api/modules/automation.md](api/modules/automation.md)) |
| Error tracking | - | none | There is no error-tracking integration; errors go to the application log | Not applicable |

A centre's own `OCR` and `MALWARE_SCAN` integration rows are stored and validated but **not read** by the
OCR and scanning modules, which use the platform setting only
([api/modules/integrations.md](api/modules/integrations.md), "Honest status of three categories").

## 4. Government integrations requiring authorisation

**No integration with any government portal or API exists, and nothing in the code automates one.** This
is the policy of section 31 of the specification, not an omission. What exists is a compliance model
([WORKFLOW_DOCUMENTATION.md](WORKFLOW_DOCUMENTATION.md) section 13,
[UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md) section 6):

| Element | What exists | What does not exist |
| --- | --- | --- |
| Submission channels | A service declares a capability (document preparation only, submission by the centre, coordination through an authorised partner). A request can be recorded as submitted only through a channel the capability allows: `MANUAL_PORTAL` (staff used the official portal separately and typed the reference), `AUTHORISED_PARTNER` (partner name mandatory) | `OFFICIAL_API`: the channel and an abstract adapter interface exist; **no adapter exists**, so the channel always answers `422 OFFICIAL_INTEGRATION_NOT_AVAILABLE` |
| Authorisation records | A centre records the authorisations it holds, with evidence; a platform administrator marks them verified. Records refuse to store anything that looks like a user name, password, PIN or OTP | Any check of an authorisation with an authority. "Verified" means a person at the operator looked at the evidence |
| Status labels | Every external status carries its source: internal, staff-entered ("Entered by staff (not verified by the authority)"), partner-provided, verified official. Clients cannot set the source | `VERIFIED_OFFICIAL` can never occur, because no adapter can produce it. Nothing stops staff typing a wrong status; the label says where it came from, not that it is true |
| Forbidden techniques | None of these is in the code: CAPTCHA bypass, OTP interception, portal automation, credential storage or sharing, scraping, fabricated approvals or statuses | - |

What an official integration would need, for any authority (ICP, MOHRE, GDRFA, Tasheel- or Amer-type
channels, or any other): the authority's documented API access and its authorisation of the centre and of
the operator, provider-issued credentials, an adapter written against the authority's sandbox, a legal
review of the terms, and a release of TypEase that registers the adapter for the `OFFICIAL_API` channel.
None of this has been sought or obtained for this software. **This documentation does not suggest, and the
software does not support, any way around that requirement.**

## 5. Functional gaps by area

One line per item. "Spec" names the section of [brand/MASTER_PROMPT.md](brand/MASTER_PROMPT.md).

### 5.1 Authentication and access

| Gap | Where described |
| --- | --- |
| No single sign-on (SAML, OIDC) | [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) section 3 |
| No CAPTCHA or bot challenge on public forms; rate limits only, per IP address, dependent on the proxy passing one `X-Forwarded-For` hop | SECURITY_CHECKLIST sections 3 and 6 |
| MFA is TOTP only (no SMS or email second factor, no passkeys); custom roles are never forced to enrol whatever permissions they hold; enrolment is not offered in the mobile app | SECURITY_CHECKLIST section 5 |
| No breached-password check, no password history or expiry; `PASSWORD_MIN_LENGTH` is declared but nothing reads it (the minimum is fixed at 10 in the validation schema) | SECURITY_CHECKLIST section 4 |
| No idle timeout shorter than the 30-day refresh lifetime, no binding of a session to a device or address | SECURITY_CHECKLIST section 7 |
| No API-key authentication and no public API for third parties. The plan feature `apiAccess` advertised earlier was retired: the API drops the key from plan bodies and never stores or returns it | [api/modules/subscriptions.md](api/modules/subscriptions.md), [API_DOCUMENTATION.md](API_DOCUMENTATION.md) section 8 |
| Phone OTP sign-in and owner phone verification need an SMS provider (section 3) | [api/modules/auth.md](api/modules/auth.md) |
| Email verification before first sign-in and password-change session invalidation exist but have no dedicated test | SECURITY_CHECKLIST sections 3 and 4 |

### 5.2 White label and domains

| Gap | Where described |
| --- | --- |
| Custom domains serve the **customer portal only**; the staff application and the corporate portal have one shared address each | [WHITE_LABEL_GUIDE.md](WHITE_LABEL_GUIDE.md) sections 7 and 12 |
| Domain verification checks the **TXT record only**; the CNAME is not checked, and a verified domain is not re-checked later | WHITE_LABEL_GUIDE section 12 |
| The first verified domain is the primary one; there is no action to choose another | WHITE_LABEL_GUIDE section 12 |
| No sender-address verification flow: `emailSenderVerified` is never set to true; a centre's own from-address is used only through its own SMTP connection | WHITE_LABEL_GUIDE section 8 |
| Theming is three colours; no custom fonts, CSS, layout or interface wording; no contrast adjustment in email and PDF headers | WHITE_LABEL_GUIDE section 12 |
| Logos: no resizing, no SVG, old files not deleted; WebP logos not embedded in PDFs | WHITE_LABEL_GUIDE section 12 |
| TLS for custom domains is the reverse proxy's job and was never exercised (section 2) | WHITE_LABEL_GUIDE section 7.3 |
| A separately published mobile app per centre is a build project, not a setting; no Android flavors or iOS schemes are set up | WHITE_LABEL_GUIDE section 10 |

### 5.3 Finance and tax

| Gap | Where described |
| --- | --- |
| No e-invoicing (no structured electronic invoice, no exchange through a service provider), no VAT return, no export for filing, no connection to the Federal Tax Authority | [UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md) section 4 |
| Invoice PDFs omit the centre's address, the customer's address and the customer's TRN; no full / simplified tax-invoice distinction; no reverse-charge, zero-rated or exempt classification beyond a 0 % line; no tax-point handling for deposits | UAE_COMPLIANCE_REVIEW section 4 |
| PDFs (quotations, invoices, receipts, credit notes, request summaries, subscription invoices, report exports) are **English and Latin-1 only**; Arabic text prints as `?` | UAE_COMPLIANCE_REVIEW section 7, [ARCHITECTURE.md](ARCHITECTURE.md) section 15 |
| One currency per centre (AED by default); no multi-currency, no exchange rates | UAE_COMPLIANCE_REVIEW section 4, [api/modules/finance.md](api/modules/finance.md) |
| No TRN format or validity check | UAE_COMPLIANCE_REVIEW section 4 |
| Subscription billing stores no payment method: there is no automatic card charge; the owner pays each invoice from the subscription page or by transfer, and a "collection attempt" is a reminder, not a charge | [api/modules/subscriptions.md](api/modules/subscriptions.md), [user-guides/OWNER_USER_GUIDE.md](user-guides/OWNER_USER_GUIDE.md) section 9 |
| Online payment needs a gateway (section 3); refunds through a real gateway never exercised | finance.md |
| Platform reports (MRR, tenant growth) cannot be exported to Excel or PDF | [api/modules/platform.md](api/modules/platform.md) section 1 |
| No retention rule for financial records: they are never deleted | UAE_COMPLIANCE_REVIEW section 3.7 |

### 5.4 Privacy and data protection

| Gap | Where described |
| --- | --- |
| Privacy policy and terms are one fixed template per language in the customer portal's dictionaries; a centre cannot edit them; no versioning, no record of the version a person saw, no re-acceptance; the staff application, corporate portal and mobile app have no notice of their own | [UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md) section 3.2 |
| No breach detection, no alerting on security events, no notification automation: the incident register records what people did | UAE_COMPLIANCE_REVIEW section 3.9, [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) section 22 |
| Erasure does not reach backups, application and proxy logs, messages already delivered, files downloaded or shared, data sent to an external OCR service or a payment gateway, webhook receivers, free text about the person in other people's records, issued financial-document line text, or authority reference numbers | [api/modules/privacy.md](api/modules/privacy.md) "Not covered", UAE_COMPLIANCE_REVIEW section 3.6 |
| No erasure flow for a centre's own staff, for corporate contacts (`corporate_members`) or for platform staff | privacy.md "Not covered" |
| Retention is enforced automatically for `DOCUMENT` / `DELETE` policies only; `CUSTOMER`, `NOTIFICATION` and `SUPPORT_TICKET` policies are stored as "not enforced"; no retention for audit and security logs, requests, consent history or application logs; the starting periods are developer placeholders | privacy.md section 3, UAE_COMPLIANCE_REVIEW section 3.7 |
| The export file for an access request omits quotations, appointments, tickets, notifications, reminders, comments and file contents | UAE_COMPLIANCE_REVIEW section 3.6 |
| No "restriction of processing" state; no automated identity check of a requester | UAE_COMPLIANCE_REVIEW section 3.6 |
| No opt-in consent step for staff-initiated OCR; no consent records for corporate employees and guests | UAE_COMPLIANCE_REVIEW section 11 |
| The processor register is a record: it does not block a connection that has no entry, and connecting a provider does not create one | UAE_COMPLIANCE_REVIEW section 3.11 |
| No technical control over hosting region or vendor location | UAE_COMPLIANCE_REVIEW section 3.10 |
| Field-level encryption covers identity numbers, OCR results, MFA secrets and integration credentials only; form answers and all other personal data are stored in clear | SECURITY_CHECKLIST section 14 |
| **Encryption-key rotation does not work as coded**; no re-encryption tool; no HMAC key rotation. Do not replace `DATA_ENCRYPTION_KEY` on a system with data | SECURITY_CHECKLIST section 14 |
| No record of processing activities, impact assessment, DPO record, training records or agreement templates | UAE_COMPLIANCE_REVIEW section 3.12 |

### 5.5 Requests, workflows and catalogue

| Gap | Where described |
| --- | --- |
| No hand-over, collection or courier step: no "collected" status, no signature capture, no dispatch tracking (spec section 13, step 22 is a notification and a download) | [WORKFLOW_DOCUMENTATION.md](WORKFLOW_DOCUMENTATION.md) section 9 |
| No bulk migration of running requests to a new workflow version (one at a time, by hand) | WORKFLOW_DOCUMENTATION section 3 |
| Prices and workflow versions cannot be scheduled for a future date; a new price takes effect at once | [api/modules/catalogue.md](api/modules/catalogue.md), [user-guides/OWNER_USER_GUIDE.md](user-guides/OWNER_USER_GUIDE.md) section 4 |
| No scripting in workflow or automation rules; notification texts written by the centre are stored as written and not translated | WORKFLOW_DOCUMENTATION section 15 |
| Merging of duplicate customers cannot be undone | OWNER_USER_GUIDE section 10 |
| A cancelled request cannot be opened again | OWNER_USER_GUIDE section 10 |

### 5.6 Corporate portal

| Gap | Where described |
| --- | --- |
| A company cannot register itself; it is created and verified by the centre, and users join by invitation | [user-guides/CUSTOMER_USER_GUIDE.md](user-guides/CUSTOMER_USER_GUIDE.md) section 16 |
| The portal has a shared address only (no custom domain) and no privacy notice of its own | [WHITE_LABEL_GUIDE.md](WHITE_LABEL_GUIDE.md) section 7, UAE_COMPLIANCE_REVIEW section 3.2 |
| Consent records are kept for customers, not for corporate employees | UAE_COMPLIANCE_REVIEW section 11 |
| The portal was completed last (commit `dd090c8`) and has had the least checking: 59 screenshot scenario entries and 22 kept pictures, no browser test suite | [TEST_REPORT.md](TEST_REPORT.md) section 2.7 |
| The mobile app has no company-account screens; company users can only sign in | [../apps/customer-mobile/README.md](../apps/customer-mobile/README.md) |

### 5.7 Platform console

| Gap | Where described |
| --- | --- |
| No console action to open a support session into a centre after an approved access grant. The API route (`POST /platform/access-grants/:id/enter`) and the staff application's landing page (`/support-session`) exist; the console has no button that calls the route | [user-guides/PLATFORM_ADMIN_GUIDE.md](user-guides/PLATFORM_ADMIN_GUIDE.md) section 10 |
| No export of a centre's data and no restore of a single centre; backups are whole-database | PLATFORM_ADMIN_GUIDE section 16, SECURITY_CHECKLIST section 21 |
| No Excel or PDF export of platform reports | [api/modules/platform.md](api/modules/platform.md) |
| No alerts on security events; somebody has to look | SECURITY_CHECKLIST section 22 |
| A centre cannot list the security events of its own centre | SECURITY_CHECKLIST section 22 |
| Privacy policy and terms text are not editable from the console or by a centre (rebuild needed) | PLATFORM_ADMIN_GUIDE section 16 |
| The first platform administrator is created with a command-line tool, not in the console | PLATFORM_ADMIN_GUIDE section 2 |
| Per-centre metrics, HTTP request metrics and tracing are not implemented | SECURITY_CHECKLIST section 22 |

### 5.8 Mobile app

Everything in this list is a statement about source code that has never been compiled
([../apps/customer-mobile/README.md](../apps/customer-mobile/README.md), "Known limitations").

| Gap |
| --- |
| Never compiled or run; about 3,200 lines of Dart tests never executed; the README lists the package and Flutter APIs most likely to need correction at the first compile |
| No PDF download of quotations, invoices and receipts (amounts and lines shown on screen) |
| Form answers are read-only after submission; corrections asked for by the centre must be made in the web portal |
| No MFA enrolment (signing in with an existing authenticator or recovery code works) |
| No in-app QR scanner, no offline mode, no company-account screens |
| No certificate pinning, root or jailbreak detection, screenshot protection, code obfuscation or biometric unlock |
| Push notifications depend on FCM (section 3); no device has ever registered |

### 5.9 Reports

| Gap | Where described |
| --- | --- |
| Operational (non-financial) reports are not reconciled against an independent model by the acceptance suite; the eight financial reports are | [../tests/README.md](../tests/README.md), scenario 30 |
| The content of XLSX and PDF exports and of scheduled report files is not tested beyond headers and access rules | tests/README.md scenarios 25 and 30 |
| Report exports have English column headings only | UAE_COMPLIANCE_REVIEW section 7 |
| Reports assume one currency and the `Asia/Dubai` time zone; periods longer than two days are not exercised by the acceptance suite | tests/README.md scenario 30 |

### 5.10 Language and OCR

| Gap | Where described |
| --- | --- |
| API error and validation messages are **English only**; the web apps translate known codes and otherwise show the English text | [UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md) section 7 |
| PDFs are English / Latin-1 only (section 5.3) | UAE_COMPLIANCE_REVIEW section 7 |
| OCR: no Arabic recognition (English Tesseract model only); MRZ and Latin text only; trade-licence extraction is label matching; Tesseract tested on one synthetic image, never on a photograph; no PDF input with Tesseract | [api/modules/ocr.md](api/modules/ocr.md) section 1 |
| Search: no normalisation of Arabic letter variants; Gregorian calendar and Western digits only | UAE_COMPLIANCE_REVIEW section 7 |
| The Arabic interface of the mobile app has never been observed (never compiled) | UAE_COMPLIANCE_REVIEW section 7 |

### 5.11 Notifications

| Gap | Where described |
| --- | --- |
| Delivery by a real provider never verified for any channel (section 3); SMS, WhatsApp and push retry behaviour tested against local fakes only | [api/modules/notifications.md](api/modules/notifications.md), tests/README.md scenarios 16 and 27 |
| WhatsApp sends template messages only; templates must be approved in the centre's business account | notifications.md |
| Rendering of HTML email in mail clients, and favicon rendering, not checked | tests/README.md scenario 22 |
| Retry back-off timing not observed (attempts run immediately in the inline queue used by the tests) | tests/README.md scenario 27 |
| Dunning emails for subscription billing not covered by the acceptance suite | tests/README.md scenario 21 |

### 5.12 Automation

| Gap | Where described |
| --- | --- |
| Automations can move a request only along the edges marked automatic in the transition table; they cannot approve, review, complete, cancel or submit, and one automation cannot start another. This is by design (spec section 32, last paragraph) and is listed here so that nobody expects otherwise | [api/modules/automation.md](api/modules/automation.md), "What an automation can never do" |
| Webhook destinations are limited to the n8n base address or `OUTBOUND_WEBHOOK_ALLOWED_HOSTS`; payloads carry identifiers, codes, amounts and dates only | automation.md, [API_DOCUMENTATION.md](API_DOCUMENTATION.md) section 8 |
| No general event-subscription API for third parties | API_DOCUMENTATION section 8 |
| No n8n instance ever called (section 3) | - |

### 5.13 Operations and deployment

| Gap | Where described |
| --- | --- |
| No secret-manager integration (Vault, cloud secret stores); keys are environment variables; no HSM or KMS | [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) section 16 |
| No dependency-update tooling, licence review, image scanning, SBOM or image signing; base images pinned by tag, not digest; actions pinned by tag, not SHA | SECURITY_CHECKLIST section 20 |
| Audit trail is append-only for the application but not tamper-evident against a database administrator; no retention or archiving of audit data | SECURITY_CHECKLIST section 17 |
| No `SECURITY.md` or `security.txt`; no incident-response plan (operator responsibility) | SECURITY_CHECKLIST section 22 |
| Single-process mode (`QUEUE_DRIVER=inline`) loses in-memory jobs on restart and runs cron schedules only in the worker | [architecture/WORKER.md](architecture/WORKER.md), [ARCHITECTURE.md](ARCHITECTURE.md) section 15 |
| Shared database, bucket, queue and logs for all centres; no dedicated-database mode (spec section 5 lists it as optional) | [TENANT_ISOLATION.md](TENANT_ISOLATION.md) section 10 |
| Lint passes with 0 errors in all 16 targets at the final run, but only inside per-package warning budgets: `services/api` carries 366 `@typescript-eslint/no-explicit-any` warnings (`--max-warnings=366`), `database` 8, `centre-web` 1 ([verification/final-run.md](verification/final-run.md), "Lint summary"); `@next/eslint-plugin-next` and `eslint-plugin-jsx-a11y` are not installed | [architecture/LINTING.md](architecture/LINTING.md), [TEST_REPORT.md](TEST_REPORT.md) section 2.1 |

## 6. Security review status

- **No independent security review, code audit or penetration test has been performed** on this code base.
  Every "Implemented" in [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) means that the control exists in the
  code and, where a test is named, that a test written by the same team exercises it.
- **No dependency audit result exists**: `pnpm audit --prod` is wired into CI, and CI has not run.
- **No accessibility audit** of any application has been made; contrast of colour pairs is computed and
  tested, nothing else.
- **No legal or tax review** has taken place; [UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md) is an
  engineering self-assessment with the questions for the advisers in its section 10.
- The items a reviewer should read first are listed in SECURITY_CHECKLIST section 24; the ones with the
  widest effect are the non-working encryption-key rotation, clear-text storage of personal data outside
  identity numbers, the default-off malware scan, TOTP-only MFA, IP-only rate limits and the absence of any
  alerting.

## 7. Test-coverage gaps

What the automated tests do cover, by level, is in [TESTING.md](TESTING.md) and, scenario by scenario, in
[../tests/README.md](../tests/README.md). What they do not:

| Gap | Evidence |
| --- | --- |
| **No browser end-to-end tests.** `tests/e2e/` holds no Playwright configuration and no spec; `pnpm test:e2e` prints `tests/e2e/README.md` and exits 1 by design. The screens were verified by engineers driving them through the screenshot runner and its scenario files (`apps/*/scripts/shots*.mjs`; [TEST_REPORT.md](TEST_REPORT.md) section 2.7); the runner reports failed steps and console errors, and one file (`shots-foundation.mjs`) asserts with `check(...)`, but nobody re-runs it on a change and no pass / fail record exists: manual verification with pictures, not an automated suite | `ls tests/e2e`, [../tests/e2e/README.md](../tests/e2e/README.md), [TESTING.md](TESTING.md) section 1 |
| **No load or performance tests** of any kind; no figures for throughput, latency or memory under load | tests/README.md, "What this suite does not do" |
| **No test against a real provider** (section 3): payments, email relay, SMS, WhatsApp, push, S3, ClamAV, external OCR, n8n, DNS, certificates | tests/README.md, TESTING.md section 3 |
| **The worker process under BullMQ** is covered by one module spec (`services/api/src/modules/platform/worker.bullmq.spec.ts`) and the notifications BullMQ spec; every other test runs jobs inline in the API process, so cron timing, repeatable jobs, retry back-off and the separate process are otherwise unobserved | TESTING.md section 4, tests/README.md scenario 19 |
| **No accessibility audit tooling** (no `jsx-a11y`, no axe run) | [architecture/LINTING.md](architecture/LINTING.md), [WHITE_LABEL_GUIDE.md](WHITE_LABEL_GUIDE.md) section 12 |
| **Flutter tests never executed** (section 2) | [../apps/customer-mobile/README.md](../apps/customer-mobile/README.md) |
| Rate limits are switched off in the test environment (`RATE_LIMIT_ENABLED=false`); MFA enforcement is `optional` there; phone verification is off; the global limit, the per-route limits and MFA enforcement for privileged roles have no test | TESTING.md section 4, SECURITY_CHECKLIST sections 5 and 6 |
| Controls listed in SECURITY_CHECKLIST as "Not verified by a test": production start-up refusals, CORS allow-list, security headers of the API, email verification before first sign-in, token expiry and reuse of one-time links, regex denial-of-service resistance of centre-supplied patterns, among others | SECURITY_CHECKLIST sections 3 to 12 |
| Isolation of files in object storage across centres, of cache keys in Redis and of dedicated-database deployments is not tested | tests/README.md, after scenario 24 |
| Cookie behaviour in real browsers (`Secure`, cross-site), TLS, HSTS and the reverse proxy are outside the suite | tests/README.md, scenario 24 authentication file |
| Multi-instance behaviour and connection poolers never run | TENANT_ISOLATION section 10 |

## 8. Operational items before go-live

The software does not do these; the operator must, and must record that they were done.

1. Run the read-only readiness check against the production environment and database and reach 0 FAIL,
   with every WARN read and accepted in writing:
   [`scripts/production-readiness.mjs`](../scripts/production-readiness.mjs)
   (`pnpm check:production -- --env-file <file> --backup-marker <file>`), described in
   [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) section 12. A passing run is necessary, not sufficient.
2. Work through the **pre-go-live checklist for the operator** in [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md)
   section 25: independent review, dependency audit, legal review, fresh secrets, key escrow, the production
   switches (`MFA_ENFORCEMENT=required`, `COOKIE_SECURE=true`, `EXPOSE_DEV_TOKENS=false`,
   `PAYMENT_SANDBOX_ENABLED=false`, `RATE_LIMIT_ENABLED=true`, no `log` driver on a channel in use), database
   roles, network exposure, S3 bucket settings, ClamAV, provider tests, backups, monitoring, incident contact.
3. Work through the **go-live checklist** in [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) section 14, which
   adds: the first image build and the first `docker compose up` treated as tests, a restore drill timed,
   a test custom domain verified end to end, the smoke test (`pnpm smoke`,
   [`scripts/smoke-test.sh`](../scripts/smoke-test.sh)) through the public URL, each provider exercised in its
   test mode with real credentials (one payment with a webhook and a refund, one email with SPF / DKIM /
   DMARC passing, one SMS, one upload scanned clean and the EICAR file quarantined), rollback rehearsed, and
   the legal and compliance decisions of [UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md) section 10
   taken by qualified advisers.
4. Keep the records listed in UAE_COMPLIANCE_REVIEW section 9 (hosting, processors, key custody, backups
   and drills, the procedure for verifying centres' authorisation records, reviews and their findings).
5. Never run the demo seed against production, and never let its accounts or their password reach a
   production system: every demo account (three centres, their staff, customers, companies and the
   platform staff `admin@typease.test` / `support@typease.test`) shares the published password
   `TypEase-Demo-2026` (or `DEMO_PASSWORD`), printed in [DEMO_ENVIRONMENT.md](DEMO_ENVIRONMENT.md) and in
   the screenshot scenario files. The seed refuses `NODE_ENV=production` and a database that already holds
   centres; the readiness check (`scripts/production-readiness.mjs`) looks for demo accounts. These guards
   do not replace the rule.
6. Commission the independent security review and the penetration test (section 6) and handle their
   findings before real identity documents are stored.

## 9. Production-readiness verdict

**TypEase is NOT production-ready until the items under "Before production" below are done.** Section 39
of the specification forbids stating readiness while critical tests, security reviews, integrations or
deployment checks remain incomplete; each of the following is such an item, and each is stated here once,
under its own heading, with the file or document that is the evidence. The sections above hold the
detail; this section is the list to be worked off.

### 9.1 The Flutter customer app was never compiled and never tested

`apps/customer-mobile` (about 19,400 lines of Dart under `lib/`, 127 files, and about 3,200 lines of tests)
was written on a machine without the Flutter / Dart SDK. No `flutter analyze`, `flutter test`,
`flutter build` or `tool/bootstrap.sh` has ever run; no device or emulator has ever loaded it; its Arabic
interface, its push registration and its tests have never been observed. Evidence:
[../apps/customer-mobile/README.md](../apps/customer-mobile/README.md) ("Verification status", "First
compile: where to look first"), [TEST_REPORT.md](TEST_REPORT.md) section 2.8, section 2 and 5.8 above.
The first compile is development work, not a formality.

### 9.2 Docker images, Compose stacks, Caddy, CI workflows and monitoring were never executed

The build environment had a Docker CLI but no daemon and no network. Nothing under `infrastructure/`
and `.github/workflows/` has been built, started or run: no image (`infrastructure/docker/*.Dockerfile`),
no `docker compose up` of `docker-compose.yml` or `docker-compose.prod.yml`, no Caddy process and no
certificate, no run of `ci.yml` / `deploy.yml` / `release.yml` (so no dependency audit, image scan or
secret scan result exists), no Prometheus / Alertmanager / Loki / Alloy / Grafana process, no MinIO. What
exists is static validation only: `pnpm check:infra` (`scripts/validate-infra.sh`: `docker compose
config`, `bash -n`, YAML / JSON parsing; the tool-dependent checks are skipped where the tools are
absent) and `scripts/deploy.sh --dry-run`. Evidence: [deployment/docker.md](deployment/docker.md)
(opening note), [deployment/ci-cd.md](deployment/ci-cd.md) section 1, [deployment/monitoring.md](deployment/monitoring.md),
[../infrastructure/monitoring/README.md](../infrastructure/monitoring/README.md),
[deployment/reverse-proxy-and-tls.md](deployment/reverse-proxy-and-tls.md), [TEST_REPORT.md](TEST_REPORT.md)
sections 2.9 and 2.10, [verification/final-run.md](verification/final-run.md), section 2 above.

### 9.3 Every external provider was verified only against local fakes or log drivers and needs real credentials

Stripe, the SMTP relay, Twilio / HTTP SMS, the Meta WhatsApp Cloud API, Firebase Cloud Messaging, S3,
ClamAV, an external OCR service, n8n, and DNS / TLS for custom domains: each adapter has met a local fake
server, a `log` driver, the `sandbox` payment adapter (refused in production), an SMTP server on
localhost, a table instead of DNS, or a single synthetic Tesseract image - never the real service. Each
needs credentials the operator obtains and each must be exercised in its test mode before go-live
(section 8, item 3). Without credentials the feature degrades as section 3 states, per service, with
its variables. Evidence: section 3 above, [TEST_REPORT.md](TEST_REPORT.md) section 5 ("Which external
services require credentials"), [TESTING.md](TESTING.md) sections 3 and 4, [../tests/README.md](../tests/README.md)
scenarios 12, 16, 21, 23, 26 and 27.

### 9.4 No government portal or official API integration exists; any would require the authority's authorisation

No integration with any authority (ICP, MOHRE, GDRFA, Tasheel- or Amer-type channels, or any other)
exists; the `OFFICIAL_API` channel always answers `422 OFFICIAL_INTEGRATION_NOT_AVAILABLE`, and
`VERIFIED_OFFICIAL` status can never occur. Building one would require the authority's documented API
access and its authorisation of the centre and of the operator, provider-issued credentials, an adapter
written against the authority's sandbox and a legal review of the terms - section 31 of the
specification. **By design there is no CAPTCHA bypass, no OTP interception, no portal automation or
scraping, no credential storage or sharing and no fabricated status anywhere in the code**, and this
documentation does not suggest a way around the requirement. Evidence: section 4 above,
[WORKFLOW_DOCUMENTATION.md](WORKFLOW_DOCUMENTATION.md) section 13, [UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md)
section 6, [TEST_REPORT.md](TEST_REPORT.md) section 5 ("Which government integrations require authorisation"),
[../tests/README.md](../tests/README.md) scenario 14 ("official API integration: none exists").

### 9.5 No independent security review or penetration test has been performed

Every control in [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) was written and, where a test is named,
tested by the same team. No external code audit, penetration test, dependency audit (`pnpm audit` is wired
into CI, which never ran) or accessibility audit exists. The items a reviewer should read first are in
SECURITY_CHECKLIST section 24; the widest-reaching known weaknesses (non-working encryption-key rotation,
clear-text personal data outside identity numbers, malware scan off by default, TOTP-only MFA, IP-only
rate limits, no alerting) are in sections 5.4 and 6 above. Evidence: section 6 above,
[SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) sections 24 and 25.

### 9.6 The browser end-to-end suite was not written; screenshot scenarios only

`tests/e2e/` has no Playwright configuration and no spec; `pnpm test:e2e` prints
[`tests/e2e/README.md`](../tests/e2e/README.md) and exits 1. The four web applications were verified by
engineers through the screenshot runner and about 399 scenario entries that drive real flows
(`packages/ui/scripts/screenshots.mjs`, `apps/*/scripts/shots*.mjs`), with pictures kept in
`docs/brand/screenshots/`; that is not an automated suite, has no pass / fail record and is not re-run on
a change. The corporate portal has had the least of it. Evidence: [../tests/e2e/README.md](../tests/e2e/README.md),
[TEST_REPORT.md](TEST_REPORT.md) section 2.7, [TESTING.md](TESTING.md) section 1, sections 2, 5.6 and 7 above.

### 9.7 API messages are English-only and PDFs are Latin-1 only

API error and validation messages exist in English only (the web apps translate known codes and otherwise
show the English text), and every generated PDF (quotations, invoices, receipts, credit notes, request
summaries, subscription invoices, report exports) is English / Latin-1: Arabic text prints as `?`. Report
exports have English column headings only. Evidence: [UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md)
section 7, [ARCHITECTURE.md](ARCHITECTURE.md) section 15, sections 5.3, 5.9 and 5.10 above.

### 9.8 The demo seed's known passwords must never go to production

Every demo account shares the published password `TypEase-Demo-2026` (or `DEMO_PASSWORD`), printed in
[DEMO_ENVIRONMENT.md](DEMO_ENVIRONMENT.md) and in the screenshot scenario files. The seed must never run
against a production database and no demo account may exist there; the seed's own refusals
(`NODE_ENV=production`, a database with centres) and the readiness check's search for demo accounts are
guards, not a substitute for the rule. Evidence: [DEMO_ENVIRONMENT.md](DEMO_ENVIRONMENT.md) (the warning at
the top and at the end), [`scripts/production-readiness.mjs`](../scripts/production-readiness.mjs)
("No demo / test accounts exist"), section 8 item 5 above.

### 9.9 Further open items that bear on the verdict

- Encryption-key rotation does not work as coded; personal data outside identity numbers is stored in
  clear; malware scanning is off by default; no alerting exists (sections 5.4 and 6).
- Legal and tax questions that decide whether the invoices, the privacy notice, the retention periods and
  the erasure scope are acceptable in the UAE are open (sections 5.3 and 5.4,
  [UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md) section 10).
- Multi-instance deployment and connection poolers have never been run (section 2); no load or
  performance figures exist (section 7).

### Before production

TypEase is not production-ready until each of these is done and recorded by the operator. Each points to
the procedure that describes it; none is done by the software.

1. **Credentials** for every provider in section 3 obtained and placed in the production environment
   through the secrets procedure ([deployment/secrets.md](deployment/secrets.md), `pnpm secrets:generate`
   for the application's own keys), with the production switches set
   ([SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) section 25) and `pnpm check:production` at 0 FAIL
   (section 8, item 1).
2. **Real-provider verification** in each provider's test mode with real credentials: one online payment
   with its webhook and a refund, one email with SPF / DKIM / DMARC passing, one SMS, one WhatsApp template
   message, one push to a registered device, one upload to the S3 bucket and its signed download, one
   upload scanned clean by ClamAV and the EICAR file quarantined, one OCR extraction, one n8n call, and a
   test custom domain verified with a real DNS record and a real certificate. The go-live checklist of
   [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) section 14 names the payment, email, SMS, scan and custom-domain
   checks; this list extends it to every provider of section 3, because none of them has met the real
   service (9.3 above).
3. **Flutter build**: `tool/bootstrap.sh` with a real SDK, `flutter analyze` and `flutter test` clean, a
   debug build on a device for Android and iOS, then the release builds
   ([../apps/customer-mobile/README.md](../apps/customer-mobile/README.md); 9.1 above).
4. **Docker deployment rehearsal**: the first image builds and the first `docker compose up` of the
   production stack treated as tests, Caddy serving the four applications and the API with certificates,
   the migration job, the worker, the monitoring profile with a real Alertmanager receiver, the smoke
   test through the public URL (`pnpm smoke`), and a rollback rehearsed
   ([deployment/docker.md](deployment/docker.md) section 5, [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)
   section 14, [deployment/upgrades-and-rollbacks.md](deployment/upgrades-and-rollbacks.md); 9.2 above).
5. **Security review**: an independent security review and penetration test commissioned and their
   findings handled before real identity documents are stored, plus a dependency audit from the first CI
   run ([SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md) sections 24 and 25; 9.5 above).
6. **Legal review of the compliance document**: the questions of [UAE_COMPLIANCE_REVIEW.md](UAE_COMPLIANCE_REVIEW.md)
   section 10 (invoices and tax, privacy notice and terms, retention periods, erasure scope, processor
   records, hosting location) answered by qualified advisers, and the records of its section 9 kept
   (9.9 above).
7. **Backup / restore drill** from the off-site copy on a separate instance, timed (the RTO input), with
   `last-restore-drill.json` in place for the readiness check, and repeated on the schedule the operator
   sets ([security/BACKUP_AND_RECOVERY.md](security/BACKUP_AND_RECOVERY.md) sections 7 and 9,
   [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) section 14, `pnpm db:backup`, `pnpm db:restore`). Only a
   drill against the development database exists, and the off-site upload has never run (section 2 above).

The test evidence behind this verdict is in [TEST_REPORT.md](TEST_REPORT.md),
[verification/acceptance-run.md](verification/acceptance-run.md) and
[verification/final-run.md](verification/final-run.md); the operational detail of each item is in section 8.
