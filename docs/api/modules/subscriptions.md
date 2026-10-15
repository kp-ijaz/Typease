# Subscriptions module (SaaS billing of typing centres by TypEase)

Plans, coupons, a centre's subscription, subscription invoices and their lifecycle (trial, renewal, failed
payment, grace period, suspension, cancellation). Code: `services/api/src/modules/subscriptions`, schemas:
`packages/validation/src/subscriptions.ts`.

This is the money between a **centre and TypEase**. It is completely separate from the centre's own
customer finance (`finance.md`): its own tables (`subscription_plans`, `coupons`, `subscriptions`,
`subscription_invoices`, `subscription_events`), its own webhook route and the platform's own gateway
credentials. A subscription payment never appears in a centre's `payments`. Only the payment-gateway
adapters are shared.

Billing state is platform-controlled: the tenant-scoped database role can only **read** subscriptions,
invoices and events (and cannot read coupons at all). Every change runs on the system connection, in one
transaction per subscription with the subscription locked, and is recorded in `subscription_events`.

All paths are under `/api/v1`. Amounts in responses are two-decimal strings.

## 1. Plans and coupons are data

Prices, limits and features live in `subscription_plans` (four starting plans are bootstrapped: starter,
professional, business, enterprise). Nothing is hard-coded: `UsageService` reads the limits and features of
the plan the subscription points at (`-1` = unlimited).

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/public/plans` | public, rate-limited | - | active public plans: `[{ key, name, description, monthlyPrice, annualPrice, currency, trialDays, limits, features, sortOrder, annualSaving }]` |
| GET | `/platform/plans` | `platform.plans.manage` or `platform.billing.manage` | - | all plans + `subscriptionCount`, `pendingCount` |
| POST | `/platform/plans` | `platform.plans.manage` | `{ key, name, description?, monthlyPrice, annualPrice, currency="AED", trialDays=14, limits: { branches, staffUsers, monthlyRequests, storageMb, aiPages, notifications, corporateClients }, features: { whiteLabel, customDomains, corporatePortal, automation, aiAssistant, scheduledReports }, isPublic=true, isActive=true, sortOrder=0 }` | plan |
| PATCH | `/platform/plans/:id` | `platform.plans.manage` | any of the above except `key` and `currency` | plan |
| DELETE | `/platform/plans/:id` | `platform.plans.manage` | - | `{ status: "DELETED" }`; `409 PLAN_IN_USE` when the plan has (or had invoiced) subscribers - deactivate it instead |
| GET | `/platform/coupons` | `platform.plans.manage` or `platform.billing.manage` | - | coupons + `activeSubscriptions` |
| POST | `/platform/coupons` | `platform.plans.manage` | `{ code, description?, percentOff \| amountOff (exactly one), currency="AED", durationMonths?, maxRedemptions?, planKeys=[], validFrom?, validUntil?, isActive=true }` | coupon |
| PATCH | `/platform/coupons/:id` | `platform.plans.manage` | `{ description?, durationMonths?, maxRedemptions?, planKeys?, validFrom?, validUntil?, isActive? }` (the discount itself is fixed) | coupon |
| DELETE | `/platform/coupons/:id` | `platform.plans.manage` | - | `409 COUPON_IN_USE` once redeemed - deactivate it instead |

```json
GET /public/plans  ->  200
[ { "key": "starter", "name": "Starter", "monthlyPrice": "149.00", "annualPrice": "1490.00", "currency": "AED",
    "trialDays": 14, "annualSaving": "298.00",
    "limits": { "branches": 1, "staffUsers": 3, "monthlyRequests": 200, "storageMb": 2048, "aiPages": 0, "notifications": 500, "corporateClients": 0 },
    "features": { "whiteLabel": false, "customDomains": false, "corporatePortal": false, "automation": false, "aiAssistant": false, "scheduledReports": false } } ]
```

**Plan features** are exactly `whiteLabel`, `customDomains`, `corporatePortal`, `automation`, `aiAssistant`,
`scheduledReports` (`PLAN_FEATURE_KEYS` minus the retired keys in `common/plan-features.ts`). `apiAccess` was
advertised in earlier releases but never built (there is no API-key authentication and no public API for third
parties): it is no longer offered - not in the four default plans (the Enterprise description no longer mentions
it), not in `GET /public/plans`, `GET /platform/plans`, `GET /subscription` or the plan a console edits. An
older console that still sends `apiAccess` in `features` is accepted and the key is dropped (never stored,
never returned); an unknown key is still `400`. Plans stored by an earlier release that still carry the key are
read as if it were absent, and the platform bootstrap removes it from the stored JSON (other keys are left
alone; a rewritten Enterprise description is not touched).

A deactivated plan cannot be chosen by anyone new; current subscribers keep it. A non-public plan can only
be assigned by platform billing staff.

## 2. The centre owner's endpoints

Only the owner holds `subscription.manage`. Reading, choosing a plan, entering a coupon and paying stay
available to a **suspended or cancelled** centre (so it can always settle its invoice or come back);
changing plan, cancelling and resuming need a usable centre.

| Method | Path | Access | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/onboarding/plan` | `subscription.manage` (also suspended) | `{ planKey, billingCycle="MONTHLY", couponCode? }` | `{ outcome: "TRIAL_STARTED" \| "PAYMENT_REQUIRED" \| "ACTIVE", invoiceId, ...GET /subscription }` |
| POST | `/subscription/restart` | same | same | same - subscribe again after a cancellation or lapse |
| GET | `/subscription` | `subscription.manage` (also suspended) | - | see below |
| GET | `/subscription/invoices` | same | query `status, q, page...` | page of subscription invoices |
| GET | `/subscription/invoices/:id` | same | - | invoice |
| GET | `/subscription/invoices/:id/pdf` | same | - | `application/pdf` (TypEase branded, English only) |
| POST | `/subscription/invoices/:id/pay` | same | - | `{ invoiceId, number, amount, currency, gateway, testMode, checkoutUrl, expiresAt }` |
| POST | `/subscription/change-plan` | `subscription.manage` | `{ planKey, billingCycle? }` | `{ change: { kind, effective, invoiceId, amount }, ...GET /subscription }` |
| POST | `/subscription/cancel` | `subscription.manage` | `{ reason }` | GET /subscription |
| POST | `/subscription/resume` | `subscription.manage` | - | GET /subscription |
| POST | `/subscription/coupon` | `subscription.manage` (also suspended) | `{ code }` | GET /subscription |

```json
GET /subscription  ->  200
{
  "tenantStatus": "ACTIVE", "suspendedForNonPayment": false,
  "subscription": { "id": "...", "status": "ACTIVE", "billingCycle": "MONTHLY", "currentPeriodStart": "2026-06-01T00:00:00.000Z",
                    "currentPeriodEnd": "2026-07-01T00:00:00.000Z", "trialEndsAt": null, "trialDaysLeft": null, "graceEndsAt": null,
                    "cancelAtPeriodEnd": false, "cancelledAt": null, "cancellationReason": null, "price": "149.00" },
  "plan": { "key": "starter", "name": "Starter", "monthlyPrice": "149.00", "annualPrice": "1490.00", "currency": "AED", "limits": { ... }, "features": { ... } },
  "pendingChange": { "plan": { "key": "professional", "name": "Professional" }, "billingCycle": null, "effective": "AFTER_PAYMENT", "effectiveAt": "2026-07-01T00:00:00.000Z" },
  "coupon": { "code": "WELCOME50", "percentOff": "50.00", "amountOff": null, "endsAt": "2026-08-01T00:00:00.000Z" },
  "usage": [ { "metric": "branches", "used": 1, "limit": 1 }, { "metric": "staffUsers", "used": 2, "limit": 3 } ],
  "openInvoices": [ { "id": "...", "number": "TE-SUB-000042", "reason": "UPGRADE", "total": "133.33", "currency": "AED", "dueAt": "...", "overdue": false } ]
}
```

`usage` comes from `UsageService.summary()` (used vs. plan limit for every metric).

### Choosing a plan
- A centre's **first** subscription on a plan with `trialDays > 0` starts as a trial: status `TRIALING`, no
  invoice, `trialEndsAt = now + trialDays`. `tenants.status` is not touched here - onboarding completion
  (tenancy module) sets it.
- Otherwise the first period is invoiced immediately (`reason FIRST_PERIOD`, due now) and the subscription is
  `PAST_DUE` until the invoice is paid.
- A centre that already has a running subscription gets `409 ALREADY_SUBSCRIBED`. After a cancellation or a
  lapse the same call (or `/subscription/restart`) issues a `RESTART` invoice - **never a second trial** -
  and the subscription becomes `ACTIVE`, with a period starting at the payment, once it is paid.

### Changing plan
The change is classified by price at the **current** billing cycle:

| Kind | When | What happens |
| --- | --- | --- |
| `UPGRADE` | new plan costs more | Immediate. A proration invoice (`reason UPGRADE`, due now) for `(new price - old price) x remaining fraction of the current period`, rounded half-up. The new plan (limits, features) **unlocks when that invoice is paid**; until then it is the `pendingChange` with `effective: "AFTER_PAYMENT"`. During a trial the plan changes immediately without an invoice. The billing period does not move. |
| `DOWNGRADE` | new plan costs the same or less | Scheduled for the end of the period (`pendingPlanId`); the renewal invoice is issued at the new plan's price. |
| `CYCLE_ONLY` | same plan, monthly <-> annual | Scheduled for the end of the period (`pendingCycle`). A cycle change requested together with an upgrade also waits for the period end. |
| `WITHDRAWN` | choosing the current plan while a change is pending | The pending change (and an unpaid upgrade invoice) is withdrawn. |

- Example: starter (149.00) to professional (349.00) with 20 of 30 days left: `200.00 x 20/30 = 133.33`.
- A change to a plan whose limits the centre **already exceeds** is refused with
  `422 DOWNGRADE_BLOCKED_BY_USAGE` and `details.exceeded: [{ metric, used, limit }]`. Checked: active
  branches, staff users, corporate clients and stored documents (monthly counters do not block).
- A second upgrade request replaces the first (the earlier upgrade invoice is voided). An upgrade invoice
  that is still unpaid when the period ends is voided; the upgrade then takes effect with the renewal.
- Refused while an invoice is overdue (`409 PAYMENT_OUTSTANDING`) or after the subscription ended
  (`409 SUBSCRIPTION_NOT_ACTIVE`).

### Coupons
- Percentage or fixed amount; validity window; maximum number of redemptions (taken atomically, so the last
  one cannot be used twice: `422 COUPON_EXHAUSTED`); optional plan restriction; optional duration in months.
  Other problems are `422 INVALID_COUPON` with `details.problem` (`INACTIVE`, `NOT_STARTED`, `EXPIRED`,
  `WRONG_PLAN`, `WRONG_CURRENCY`). Codes are case-insensitive.
- One coupon at a time per subscription (`409 COUPON_ALREADY_APPLIED`); a centre can use a given coupon once
  ever (`409 COUPON_ALREADY_USED`).
- The discount applies to every period invoice whose period starts before the coupon's end date
  (`now + durationMonths` at the time it was applied; no end date without a duration). The coupon leaves the
  subscription when a period starts on or after that date. A percentage coupon also applies to upgrade
  prorations; a fixed amount does not.
- Applying a coupon re-issues open period invoices with the discount (the old invoice is voided - issued
  amounts are never edited). An invoice that becomes free is settled without a payment.

### Cancelling
`POST /subscription/cancel` schedules the cancellation for the end of the paid period
(`cancelAtPeriodEnd`), voids a renewal invoice that was already issued and drops pending changes;
`POST /subscription/resume` withdraws it before that date. When the period (or trial) ends the subscription
becomes `CANCELLED` and the centre `CANCELLED`. Cancelling while an invoice is already overdue ends the
subscription immediately.

### Paying
`POST /subscription/invoices/:id/pay` opens a hosted checkout at the **platform** payment gateway: Stripe
when `STRIPE_SECRET_KEY` is set, otherwise the sandbox when `PAYMENT_SANDBOX_ENABLED=true` (never in
production). No gateway -> `503 INTEGRATION_NOT_CONFIGURED`; TypEase billing staff can then record a bank
transfer. TypEase does not store card details: there is no automatic card charge, the owner pays from the
subscription page.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/public/webhooks/subscriptions/:gateway` | public, rate-limited | Gateway webhook for subscription payments. `200 { received, processed, duplicate?, outcome?, reason? }` |

Same guarantees as the customer-payment webhook, with the platform's credentials: signature over the raw
body, timestamp tolerance (`400 WEBHOOK_SIGNATURE_INVALID` + security event otherwise), each event recorded
once (namespace `subscriptions:<gateway>` in `payment_webhook_events`, separate from customer payments), a
duplicate delivery returns `200` and does nothing, and the invoice is paid **exactly once** (conditional
update `OPEN -> PAID`). A mismatching amount is refused (`WEBHOOK_AMOUNT_MISMATCH`). A failed checkout
leaves the invoice open, stores the reason and emits `subscription.payment_failed`.

What a paid invoice does: an `UPGRADE` invoice switches the plan; a period invoice (`FIRST_PERIOD`,
`RENEWAL`, `RESTART`) starts its period - immediately when the period has begun or the subscription is
overdue, otherwise at the period end. After a lapse (`EXPIRED` / `CANCELLED`) the paid period starts when
the money arrives.

## 3. Platform billing administration (`platform.billing.manage`)

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/platform/billing/subscriptions` | query `status, planKey, billingCycle, tenantId, q (centre name / slug), page...` | page of subscriptions with `tenant`, `plan`, `pendingPlan`, `coupon` |
| GET | `/platform/billing/tenants/:tenantId` | - | `{ tenant, subscription, invoices, events }` - full billing history |
| GET | `/platform/billing/tenants/:tenantId/invoices/:id/pdf` | - | `application/pdf` |
| POST | `/platform/billing/invoices/:id/pay-offline` | `{ method="BANK_TRANSFER" \| "CHEQUE" \| "CASH", reference, paidAt? }` | `{ invoice, ...history }` - same consequences as an online payment |
| POST | `/platform/billing/invoices/:id/void` | `{ reason }` | history. Only `OPEN` invoices; voiding an upgrade invoice withdraws the upgrade. |
| POST | `/platform/billing/tenants/:tenantId/extend-trial` | `{ days, reason }` | history. For a centre in trial, or one whose trial ran out without ever paying (it returns to `TRIALING`, the unpaid invoice is voided). |
| POST | `/platform/billing/tenants/:tenantId/coupon` | `{ code }` | history |
| POST | `/platform/billing/tenants/:tenantId/change-plan` | `{ planKey, billingCycle?, immediate=false, reason }` | `{ change, ...history }`. May assign non-public plans. `immediate: true` switches now without a proration invoice. The usage rule still applies. |

Platform support agents (no `platform.billing.manage`) and tenant users get `403`.

**Operators' note**: to bring back a centre that is suspended for non-payment, fix its *billing* (record
the payment, extend the trial, void / re-plan) - do not just flip `tenants.status`. The hourly job
re-derives the centre's status from its subscription and would suspend it again.

## 4. Invoices and numbering

Subscription invoices are numbered globally `TE-SUB-000001`, `TE-SUB-000002`, ... from a counter row in
`platform_settings` (`subscriptions.invoice_sequence`) that is incremented with a row lock inside the
invoice's own transaction: concurrent invoices never share a number and a rolled-back invoice does not burn
one. `total = subtotal - discount + tax`. Issued amounts are never edited - a changed price means void and
re-issue. Statuses: `OPEN`, `PAID`, `VOID`.

Tax on subscription invoices and the dunning timings are read from `platform_settings` key
`subscriptions.policy` (JSON, all optional): `{ renewalLeadDays: 7, trialReminderDays: 3, retryDelaysDays: [1, 2], graceDays: 7, taxRatePercent: 0 }`.
The default tax rate is 0 - set `taxRatePercent` when TypEase has to charge tax on its subscriptions.

## 5. Lifecycle job

`subscriptions.lifecycle`, hourly (`0 * * * *`), cross-tenant on the system connection, idempotent (every
step first checks whether it was already done; one centre failing never stops the others).

| State | Trigger | Result |
| --- | --- | --- |
| `TRIALING` | 3 days before `trialEndsAt` | `subscription.renewal_due` (once) |
| `TRIALING` | trial over | first invoice (`FIRST_PERIOD`, period starts at the trial end); unpaid -> `PAST_DUE` |
| `ACTIVE` | 7 days before `currentPeriodEnd` | renewal invoice (`RENEWAL`, due at the period end, priced for the pending plan / cycle) + `subscription.renewal_due` |
| `ACTIVE` | period over, renewal paid | next period starts; pending plan / cycle applied; coupon dropped when its months are over |
| `ACTIVE` | period over, renewal unpaid | `PAST_DUE`, first failed collection attempt |
| `PAST_DUE` | `nextAttemptAt` reached | next attempt (default: 1 day after the due date, then 2 days later); each one counts `attemptCount`, sets `nextAttemptAt` and emits `subscription.payment_failed` |
| `PAST_DUE` | attempts used up | `GRACE`, `graceEndsAt = now + 7 days` |
| `GRACE` | grace over | subscription `EXPIRED`; centre `SUSPENDED` with `suspensionReason = "SUBSCRIPTION_UNPAID"`. The invoice stays open. |
| any | `cancelAtPeriodEnd` and period over | `CANCELLED`; centre `CANCELLED`; open invoices voided |

An "attempt" is a collection attempt, not a card charge: TypEase stores no payment method, so each attempt
checks that the invoice is still unpaid and notifies the centre.

**Payment at any point reactivates**: during `PAST_DUE` / `GRACE` the subscription becomes `ACTIVE` for the
invoiced period; after suspension it becomes `ACTIVE` with a period starting at the payment and the centre
returns to `ACTIVE` - but only if it was suspended for non-payment.

`tenants.status` is kept in step on every run: `TRIAL` while `TRIALING`, `ACTIVE`, `PAST_DUE` (also during
`GRACE` - the centre keeps working), `SUSPENDED` when `EXPIRED`, `CANCELLED`. It is **never** changed while
the centre is `ONBOARDING`, `PENDING_APPROVAL` or `ARCHIVED`, nor when it was suspended by a platform
administrator for another reason.

The time the module believes it is comes from the injectable `BillingClock`, so tests move time instead of
waiting.

## 6. Events

Emitted on the system outbox (`events.emitSystem`, after the billing transaction commits, with the tenant id):

| Event | When | Payload |
| --- | --- | --- |
| `subscription.renewal_due` | trial ending in 3 days; renewal invoice created | `{ subscriptionId, dueAt, amount, currency, invoiceId?, invoiceNumber?, planKey, planName, kind: "TRIAL_ENDING" \| "RENEWAL" }` |
| `subscription.payment_failed` | each failed collection attempt; a failed checkout | `{ subscriptionId, invoiceId, invoiceNumber, amount, currency, attempt, reason, nextAttemptAt?, graceEndsAt? }` |

Consumed: none.

`subscription_events` (the billing history shown to platform staff) records every transition:
`TRIAL_STARTED`, `STARTED`, `RESTART_REQUESTED`, `TRIAL_ENDING`, `TRIAL_ENDED`, `TRIAL_EXTENDED`,
`INVOICE_CREATED`, `INVOICE_PAID`, `INVOICE_VOIDED`, `CHECKOUT_STARTED`, `CHECKOUT_FAILED`,
`PAYMENT_ATTEMPT_FAILED`, `STATUS_CHANGED { from, to }`, `ACTIVATED`, `RENEWED`, `UPGRADE_REQUESTED`,
`PLAN_CHANGE_SCHEDULED`, `CYCLE_CHANGE_SCHEDULED`, `PLAN_CHANGE_WITHDRAWN`, `PLAN_CHANGED`, `CYCLE_CHANGED`,
`COUPON_APPLIED`, `COUPON_ENDED`, `CANCEL_SCHEDULED`, `RESUMED`, `CANCELLED`, `SUSPENDED_FOR_NON_PAYMENT`,
`PAYMENT_FOR_CLOSED_INVOICE`.

Audit entries (`subscription.*`, `platform.plan_*`, `platform.coupon_*`, `platform.subscription_*`,
`tenant.status_changed_by_billing`) are written for every action by an owner or by platform staff.

## 7. Error codes a client should handle

| Code | HTTP | Meaning |
| --- | --- | --- |
| `PLAN_NOT_AVAILABLE` | 422 | unknown, inactive or private plan |
| `ALREADY_SUBSCRIBED` | 409 | the centre already has a running subscription |
| `NO_CHANGE` | 409 | already on that plan and cycle |
| `DOWNGRADE_BLOCKED_BY_USAGE` | 422 | current usage exceeds the target plan (`details.exceeded`) |
| `PAYMENT_OUTSTANDING` / `SUBSCRIPTION_NOT_ACTIVE` | 409 | plan change not possible in this state |
| `INVALID_COUPON` / `COUPON_EXHAUSTED` | 422 | coupon cannot be used |
| `COUPON_ALREADY_APPLIED` / `COUPON_ALREADY_USED` | 409 | coupon rules |
| `ALREADY_CANCELLING` / `NOT_CANCELLING` | 409 | cancel / resume in the wrong state |
| `INVOICE_NOT_PAYABLE` | 409 | invoice is paid or void |
| `INTEGRATION_NOT_CONFIGURED` | 503 | no platform payment gateway |
| `PLAN_LIMIT_REACHED` | 402 | (from other modules) the plan's limit is reached - upgrade |
| `TENANT_UNAVAILABLE` | 403 | the centre is suspended or cancelled; only the "also suspended" endpoints work |
