# Notifications

Module folder: `services/api/src/modules/notifications`. Tables: `notification_templates`, `notifications`,
`notification_deliveries`, `notification_preferences`, `device_tokens`. All paths are under `/api/v1`.

The module is the only writer of the `notifications` table. Other modules never call it: they emit domain
events, and the account-security flows use the `Messenger` port, whose transport this module plugs in.

## Endpoints

### Staff (permission `notification.manage`)

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/notifications` | `page, pageSize, sort (createdAt, sentAt, status, channel, eventKey), q (address or subject), status, channel, eventKey, customerId, from, to (YYYY-MM-DD, UTC days)` | Paged delivery log |
| GET | `/notifications/failures` | `page, pageSize, channel, eventKey, from, to` | Paged FAILED notifications + `summary { total, byChannel[], byEvent[] }` |
| GET | `/notifications/channels` | - | Provider per channel (no credentials) |
| GET | `/notifications/settings` | - | `{ rateLimitPerHour, events[] }` |
| PUT | `/notifications/settings` | `{ events?: { [eventKey]: { [channel]: boolean } }, rateLimitPerHour?: 1-200 }` | Same as GET |
| GET | `/notifications/events` | - | Event catalogue with the variables each template may use |
| PATCH | `/notifications/events/:eventKey/channels/:channel` | `{ enabled: boolean }` | Same as GET settings |
| GET | `/notifications/templates` | `eventKey, channel, language` | Effective templates (override else default) |
| POST | `/notifications/templates/preview` | `{ eventKey, channel, language, subject?, body?, data? }` | Rendered preview, nothing is sent |
| PUT | `/notifications/templates/:eventKey/:channel/:language` | `{ subject?, body, name?, whatsappTemplateName? }` | The override + `unknownVariables[]` |
| DELETE | `/notifications/templates/:eventKey/:channel/:language` | - | Reset to the platform default (404 when there is no override) |
| GET | `/notifications/:id` | - | Log row + `body` + `deliveries[]` |
| POST | `/notifications/:id/retry` | - | `{ id, status: "QUEUED" }`; 409 `NOT_RETRYABLE` unless the notification is FAILED |

Delivery log row:

```json
{
  "id": "0b0c...", "eventKey": "request.completed", "eventLabel": "Application completed",
  "channel": "EMAIL", "language": "en", "status": "SENT", "suppressedReason": null,
  "recipientAddress": "fatima@example.com", "recipientCustomerId": "5f1e...", "recipientUserId": null,
  "subject": "Your request TE-000123 is complete", "relatedType": "ServiceRequest", "relatedId": "9a77...",
  "createdAt": "2026-10-09T08:00:00.000Z", "sentAt": "2026-10-09T08:00:02.000Z",
  "attempts": 2, "provider": "smtp", "lastError": "smtp: 451 Try again later"
}
```

`GET /notifications/channels`:

```json
[
  { "channel": "EMAIL", "provider": "smtp", "source": "TENANT", "configured": true, "detail": null },
  { "channel": "SMS", "provider": null, "source": "NONE", "configured": false, "detail": "SMS delivery is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM." },
  { "channel": "WHATSAPP", "provider": "log", "source": "PLATFORM", "configured": true, "detail": "Development mode: messages are written to the server log and not sent." },
  { "channel": "PUSH", "provider": "fcm", "source": "PLATFORM", "configured": true, "detail": null },
  { "channel": "IN_APP", "provider": "in-app", "source": "BUILT_IN", "configured": true, "detail": null }
]
```

Template list row: `{ eventKey, label, group, channel, language, source: "TENANT" | "DEFAULT", name, subject, body,
whatsappTemplateName, enabled, default: { subject, body } | null, variables[] }`.

Preview response: `{ subject, text, html (EMAIL only, full branded page), whatsappParameters (WHATSAPP only),
unknownVariables[], sampleData }`.

### Every signed-in member of a centre (staff, customers, corporate users)

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/me/notifications` | `page, pageSize, unreadOnly` | `{ data[], meta, unreadCount }` |
| POST | `/me/notifications/:id/read` | - | `{ id, readAt }` (404 for someone else's notification) |
| POST | `/me/notifications/read-all` | - | `{ updated }` |
| GET | `/me/notification-preferences` | - | `{ channels, groups, channelDefaults, preferences[], note }` |
| PUT | `/me/notification-preferences` | `{ preferences: [{ channel, eventGroup: "*" or group, enabled }] }` | Same as GET |
| GET | `/me/devices` | - | `[{ id, platform, createdAt, lastSeenAt }]` (tokens are never returned) |
| POST | `/me/devices` | `{ token, platform: "ios" | "android" | "web" }` | `{ id, platform, registeredAt, lastSeenAt }` |
| DELETE | `/me/devices` | `{ token }` | `{ removed }` |

Inbox item: `{ id, eventKey, subject, body, language, relatedType, relatedId, readAt, createdAt }`. Use
`relatedType` / `relatedId` (`ServiceRequest`, `Quotation`, `Invoice`, `Payment`, `Appointment`, `SupportTicket`,
`ReminderSchedule`, `Subscription`, `Customer`) to deep-link.

Preference groups: `account, requests, payments, appointments, reminders, support, billing, reports, marketing`.
A customer's preferences belong to the customer record; staff and company users have their own.

## Channels and providers

| Channel | Adapters | Verified how |
| --- | --- | --- |
| EMAIL | `smtp` (nodemailer), `log` | SMTP adapter integration-tested against a real local `smtp-server` (subject, from name, recipient, body, auth) |
| SMS | `twilio` (REST, Basic auth, form-encoded), `http` (POST JSON `{ to, body }` with bearer token), `log` | Local fake HTTP server only: exact URL, auth header and body asserted. **Not verified against the live provider.** |
| WHATSAPP | `meta` (WhatsApp Business Cloud API, `POST /{phone-number-id}/messages`, TEMPLATE messages only), `log` | Local fake HTTP server only. **Not verified against Meta.** |
| PUSH | `fcm` (HTTP v1; OAuth token from the service-account key, RS256 JWT, cached until expiry), `log` | Local fake HTTP server only (JWT signature verified with the public key). **Not verified against Google.** |
| IN_APP | stored only | - |

Provider selection per centre: the centre's own **ACTIVE** row in `integration_credentials_metadata` (category
`EMAIL` / `SMS` / `WHATSAPP` / `PUSH`) wins, otherwise the platform default from the environment
(`MAIL_DRIVER`, `SMS_DRIVER`, `WHATSAPP_DRIVER`, `PUSH_DRIVER`). Expected integration rows:

| category / provider | `config` (not secret) | `secretsEnc` (JSON, encrypted) |
| --- | --- | --- |
| EMAIL / smtp | `host, port, secure, requireTls?, fromAddress?, fromName?` | `user, password` |
| SMS / twilio | `accountSid, from` (number, sender id or `MG...` messaging service) | `authToken` |
| SMS / http | `url` (https, host must be in `OUTBOUND_WEBHOOK_ALLOWED_HOSTS`) | `token` |
| WHATSAPP / meta | `phoneNumberId, apiVersion?, languageCodes? { en, ar }` | `accessToken` |
| PUSH / fcm | `projectId` | `serviceAccountJson` |

- The `log` driver exists for development: the message is written to the log, the delivery is SENT with provider
  `log`. In production the `log` driver and missing credentials both fail the delivery with
  `... is not configured ...` (delivery row FAILED, provider `none`); nothing is ever reported as sent without
  a provider.
- In production a centre's own SMTP / gateway host must resolve to a public address (no private, loopback or
  link-local ranges). The FCM token endpoint is fixed to Google and never read from the uploaded key file.

## Templates

- Platform defaults (`tenantId` NULL, readable by every tenant) exist for every key of `NOTIFICATION_EVENTS`
  plus the staff-facing `request.assigned_to_you`, in English and Arabic, for EMAIL and IN_APP, with SMS and
  WHATSAPP variants for OTP, documents missing, quotation ready, payment requested / received, status
  changed, completed, appointment confirmation / reminder and document expiry. They are inserted by the
  provisioning step `notifications.templates`: missing rows are added, existing rows are never overwritten.
- Syntax: `{{variable}}`; unknown variables render empty. `[Label]({{linkVariable}})` is a link (a button in
  HTML email, `Label: url` in text); it is dropped when the URL is empty. Email bodies are plain text: every
  value and all template text is HTML-escaped, links are recognised in the template only (never in a value).
- Selection for a recipient: wanted language (centre override, then default), then English (override, then
  default). PUSH uses the IN_APP template unless a PUSH template exists. If the database holds no platform row
  at all for an event and channel (platform bootstrap not run yet), the built-in wording is used so that no
  message - above all no account-security message - is lost; a default that was deactivated stays off.
- Every template may use `centreName`, `supportEmail`, `supportPhone`. Per event (`GET /notifications/events`
  returns the same list with descriptions):

| Event key | Variables |
| --- | --- |
| `account.registered` | customerName, portalLink |
| `account.email_verification` | name, link |
| `account.password_reset` | name, link, minutes |
| `account.otp` | code, minutes |
| `staff.invitation` | name, role, link, days |
| `request.created`, `request.staff_assigned`, `request.completed` | customerName, requestNumber, serviceName, portalLink |
| `request.documents_missing` | + message |
| `request.status_changed` | + statusLabel, customerMessage |
| `request.assigned_to_you` (staff) | staffName, requestNumber, serviceName, customerName, centreLink |
| `quotation.ready` | customerName, quotationNumber, requestNumber, amount, currency, validUntil, portalLink |
| `payment.requested` | customerName, invoiceNumber, requestNumber, amount, currency, dueDate, portalLink |
| `payment.received` | customerName, receiptNumber, amount, currency, portalLink |
| `appointment.confirmation`, `appointment.reminder` | customerName, appointmentDate, appointmentTime, branchName, serviceName, portalLink |
| `document.expiry` | recipientName, documentName, subjectLabel, expiryDate, daysLeft, renewalLink |
| `document.rejected` (group `requests`) | recipientName, documentName, requestNumber ("-" outside a request), reason, portalLink |
| `subscription.renewal` | name, planName, amount, currency, renewalDate, centreLink |
| `subscription.payment_failed` | name, planName, amount, currency, reason, centreLink |
| `support.response` | recipientName, ticketNumber, ticketSubject, teamName, portalLink |
| `report.scheduled` | name, reportName, periodLabel, centreLink |
| `support_access.requested` (group `security`) | name, requesterName, reason, durationMinutes, accessKind, centreLink |
| `support_access.decided` (group `security`; sent by the platform module to TypEase staff, email only) | name, tenantName, decision, details, consoleLink |

- No template variable carries a document, storage or download URL. Links point to portal / centre pages that
  require sign-in (a unit test enforces this for the defaults).
- Email layout: branded frame from `BrandingService.publicConfig` (name, colours, logo, support contact),
  right-to-left for Arabic. Sender: display name = `brandingSettings.emailFromName` or the centre name; the
  centre's own address is used only when `brandingSettings.emailSenderVerified` is true (or when the centre
  sends through its own SMTP integration with `config.fromAddress`); otherwise the platform sender
  `MAIL_FROM_ADDRESS`. `Reply-To` is the centre's support email.
- WhatsApp: a centre must save an override with `whatsappTemplateName` (the name approved by Meta). The
  template parameters are the variables of the body in order of first appearance, so the approved template
  must use the same placeholders in the same order.

## Events consumed (after commit, idempotent)

Dedupe key: `<eventId>:<channel>:<recipient>` (unique per tenant). Handling the same event twice creates nothing.

| Domain event | Template | Recipient |
| --- | --- | --- |
| `customer.created` with `source = SELF_REGISTRATION` | `account.registered` | customer |
| `request.created` | `request.created` | customer |
| `request.information_requested` | `request.documents_missing` | customer; + the company's administrators (`corp.requests.read`) for a company request |
| `request.assigned` | `request.staff_assigned` / `request.assigned_to_you` | customer / the assigned staff member (not when they assigned it to themselves) |
| `request.status_changed` | `request.status_changed` | customer, only when `customerVisible`; not for `to = COMPLETED` or `AWAITING_CUSTOMER`, which have their own messages (`request.completed`, `request.information_requested`) |
| `request.completed` | `request.completed` | customer; + the company's administrators (`corp.requests.read`) for a company request |
| `quotation.sent` | `quotation.ready` | customer; + the company's administrators who may approve (`corp.requests.approve`) for a company quotation, with `portalLink` = the approval screen |
| `payment.requested` | `payment.requested` | customer; + the company's administrators who see invoices (`corp.invoices.read`) for a company invoice, with `portalLink` = the invoice |
| `payment.completed` | `payment.received` | customer (skipped without a customer) |
| `appointment.created` | `appointment.confirmation` | customer, or the guest's phone by SMS |
| `appointment.reminder_due` | `appointment.reminder` | same; skipped unless the appointment is BOOKED / CONFIRMED |
| `document.expiring` | `document.expiry` | customer, or the company's portal members (billing email as fallback) |
| `document.rejected` | `document.rejected` | the person the document belongs to; + the company's administrators (`corp.requests.read` for a document of a company request, `corp.employees.read` for a company document). Deleted documents are skipped; without a reviewer note the `reason` says so in words |
| `ticket.replied` | `support.response` | customer for customer-visible staff replies; the centre user who opened a PLATFORM ticket when TypEase support replies |
| `subscription.renewal_due`, `subscription.payment_failed` | `subscription.renewal`, `subscription.payment_failed` | active centre owners |
| `support_access.requested` | `support_access.requested` (EMAIL + IN_APP, English / Arabic) | every active staff member holding `support_access.decide` (the owners by default); `related` = `AccessGrant` + grant id; `centreLink` = `${CENTRE_WEB_URL}/settings?tab=support`. Skipped when the request is no longer waiting |

`staff.invited` is not mapped: the invitation is sent through `Messenger`. No events are emitted.

### Company requests: the administrators are told too

A request billed to a company (`corporateAccountId` set - raised by a company administrator, by an employee in
the corporate portal, or by staff for the company) is the company's business as much as the employee's. For the
events marked "+ the company's administrators" above, every active corporate portal member of that company whose
role holds the named permission is addressed **as a user** (`recipientUserId`, their own language and
notification preferences, dedupe key per user, so a person who is both the subject and an administrator hears it
once). Personal requests of the same person (`corporateAccountId: null`) never reach the company.

**Links open where the recipient signs in.** Every recipient carries the portal they use: company
administrators and employees whose only login is the corporate one get `${CORPORATE_WEB_URL}` links, everybody
else `${CUSTOMER_WEB_URL}` links, staff `${CENTRE_WEB_URL}`.

| Message | Corporate portal link (administrators) | Corporate portal link (the employee) | Customer portal link |
| --- | --- | --- | --- |
| `request.*`, `document.rejected` (in a request) | `/requests/:id` | `/requests/:id` | `/requests/:id` |
| `document.rejected` (outside a request) | `/documents` | `/documents` | `/documents` |
| `quotation.ready` | `/approvals/:quotationId` | `/requests/:id` (an employee cannot decide: the status is on their request) | `/quotations/:id` |
| `payment.requested` | `/invoices/:id` | `/requests/:id` | `/invoices/:id` |
| `payment.received` | `/invoices` | `/invoices` | `/payments` |
| `support.response` | `/support/:ticketId` | `/support/:ticketId` | `/support/:ticketId` |

A corporate portal link is used only when the record belongs to a company (or, for tickets, the page exists in
both portals); a personal quotation, invoice or payment of a person who happens to sign in through a company
is linked in the customer portal.

## Recipients, consent and suppression

A customer is reached at the email / phone on the customer record (falling back to the primary `customer_contacts`
entry of type EMAIL / PHONE when the profile has none; WhatsApp prefers a contact of type WHATSAPP) and, for
IN_APP and PUSH, through the portal accounts linked to it. For each enabled channel the decision is, in order:

1. Account-security messages (`account.email_verification`, `account.password_reset`, `account.otp`,
   `staff.invitation`) are always sent on the channel the flow asked for. They ignore preferences, event
   switches and the plan limit.
2. Archived / anonymised customers: `CUSTOMER_INACTIVE`. No email / phone on file: `NO_ADDRESS`.
3. Purpose consent in `customer_consents` must be **GRANTED** (a missing row counts as not granted):
   `REMINDERS` for `document.expiry` (`NO_CONSENT_REMINDERS`), `MARKETING` plus `customers.marketingOptIn` for
   marketing events (`NO_CONSENT_MARKETING`), `WHATSAPP` for anything on WhatsApp (`NO_CONSENT_WHATSAPP`).
4. An explicit row in `notification_preferences` for the channel decides (the event group beats `*`): `OPT_OUT`.
5. Otherwise `customers.communicationPrefs` (`email`, `sms`, `whatsapp`, `push`): `false` means `OPT_OUT`;
   WhatsApp additionally has to be `true`.
6. WhatsApp without an approved template name: `WHATSAPP_TEMPLATE_REQUIRED`.
7. More than `rateLimitPerHour` (default 20) messages to the same recipient on the same external channel within
   an hour: `RATE_LIMITED`.
8. The plan's monthly `notifications` limit is reached (external channels only): `PLAN_LIMIT`. In-app
   notifications are still delivered.

A suppressed notification is stored with status `SUPPRESSED` and `suppressedReason`; it is never dropped and can
never be retried. Channels a centre switched off for an event produce no row at all (configuration, not
suppression). Defaults: EMAIL + IN_APP (+ PUSH for customer events, + SMS for the operational ones); WhatsApp is
off until the centre enables it per event.

## Delivery pipeline

- Status flow: `QUEUED` -> `SENT` or `FAILED`; `SUPPRESSED` at creation; IN_APP is `SENT` immediately (stored only).
- Job `notifications.deliver` `{ tenantId, notificationId }`: 5 attempts, exponential backoff starting at 30 s.
  Each attempt is one `notification_deliveries` row (`provider`, `attempt`, `status`, `providerMessageId`,
  `error`). After the last failed attempt the notification is `FAILED` and appears in the failure report.
  Permanent errors (missing configuration, rejected recipient, 5xx SMTP reply, 4xx API reply) fail at once.
- No double send: every attempt first claims the notification in a transaction that locks the row; it only
  proceeds when the status is still `QUEUED` and no other attempt is in flight. A late or duplicate job for a
  sent notification does nothing. Emails carry a stable `Message-ID` derived from the notification id.
  Limit: if a worker dies after the provider accepted the message but before the result was stored, the attempt
  is treated as interrupted after 2 minutes and repeated (at-least-once in that one case).
- Usage: one `notifications` unit is recorded when an external-channel notification is queued and given back
  when it finally fails; a manual retry records it again.
- PUSH sends to every registered device of the person; tokens FCM reports as unregistered are deleted.
- Push data fields (FCM `message.data`, all strings; the mobile app uses them to open the right screen):
  `eventKey`, `notificationId`, and `relatedType` + `relatedId` whenever the notification record has them
  (the same values `GET /me/notifications` returns, e.g. `ServiceRequest` + the request id, `Quotation`,
  `Invoice`, `Payment`, `Appointment`, `SupportTicket`, `ReminderSchedule`). They are read from the
  notification row when the message is sent, so they are present on every push whose record has a target; a
  notification without a target (a custom message, an account message) has neither field.
- Job `notifications.maintenance` (every 10 minutes, all tenants): re-queues notifications still `QUEUED` after
  10 minutes without a recent attempt, and removes encrypted payloads of account messages older than a day.
- Job `notifications.send_direct`: account-security messages without a tenant (platform staff). Platform
  default template and provider; nothing is stored because `notifications.tenantId` is mandatory; a final
  failure is logged and written as security event `NOTIFICATION_DELIVERY_FAILED`.

## Account-security messages

`Messenger.send` (verification, password reset, OTP, invitations) creates a normal notification for the tenant,
so the same templates, branding, providers, retries and delivery log apply. Links and codes are secrets: the
stored `body` shows `[hidden]` instead, the real rendering is kept AES-encrypted in `data.secure` until the
message is sent and is then removed. The transport never throws: sign-up and password flows do not fail when
a provider is down.

## Rules a frontend / operator should know

- `GET /notifications/:id` and the log never return the internal `data` column.
- `PUT /notifications/settings` merges: only the listed events / channels change. It is stored in
  `tenant.settings.notifications` with an atomic `jsonb_set`.
- Template overrides: EMAIL requires a subject; SMS and WhatsApp have none. Unknown event keys are rejected with
  422 `UNKNOWN_EVENT`; variables that the event does not provide are reported in `unknownVariables` (they would
  render empty).
- Audit actions: `notification_template.created | updated | reset`, `notification.settings_updated`,
  `notification.retried`, `notification.preferences_updated`.
