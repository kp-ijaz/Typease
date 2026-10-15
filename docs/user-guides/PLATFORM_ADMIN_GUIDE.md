# Platform administrator guide

For the staff of the operator who runs a TypEase installation: **super admins** and **support agents**.
It covers the platform console (`apps/platform-admin`) and the few tasks that are done from a terminal.

Menu names and buttons are written as they appear in the console in English. The console pages were being
completed while this guide was written: if a screen differs from the description, the API reference
[api/modules/platform.md](../api/modules/platform.md) states what the system does.

> **The rule that shapes this console.** Platform staff manage centres, plans and billing. They do **not**
> see a centre's customers, documents or requests. To look at a centre's data you ask, with a reason, a
> scope and a duration, and the centre decides. Everything you do in the console is recorded.

## Contents

1. [Roles](#1-roles)
2. [Creating the first administrator](#2-creating-the-first-administrator)
3. [Signing in](#3-signing-in)
4. [Dashboard](#4-dashboard)
5. [Centres](#5-centres)
6. [Closing a centre and deleting its data](#6-closing-a-centre-and-deleting-its-data)
7. [Subscriptions and billing](#7-subscriptions-and-billing)
8. [Plans and coupons](#8-plans-and-coupons)
9. [Support tickets from centres](#9-support-tickets-from-centres)
10. [Access to a centre's data](#10-access-to-a-centres-data)
11. [Authorisation reviews and approved providers](#11-authorisation-reviews-and-approved-providers)
12. [Feature flags and platform settings](#12-feature-flags-and-platform-settings)
13. [Platform staff](#13-platform-staff)
14. [Audit and security](#14-audit-and-security)
15. [System health](#15-system-health)
16. [Things the console does not do](#16-things-the-console-does-not-do)

## 1. Roles

| | Super admin | Support agent |
| --- | --- | --- |
| See the list of centres and their centre-level facts | Yes | Yes |
| Add, approve, suspend, reactivate, close, delete centres | Yes | No |
| Subscriptions, invoices, plan changes, trials, coupons | Yes | No |
| Plans (view) | Yes | Yes |
| Support tickets from centres | Yes | Yes |
| Ask a centre for access to its data | Yes | Yes |
| Authorisation reviews, approved providers | Yes | No |
| Feature flags and platform settings | Yes | No |
| Platform staff | Yes | No |
| Audit log, security events, incident and processor registers | Yes | No |
| System health, platform figures | Yes | No |

Menu: **Dashboard**; under **Typing centres**: **Centres**, **Subscriptions**, **Plans** (with **Coupons**),
**Support**, **Access requests**; under **Platform**: **Integrations**, **Feature flags**, **Staff**, **Audit
& security**, **System health**. A support agent sees Dashboard, Centres, Plans, Support and Access requests.

A platform account is separate from any centre account: the same email address cannot be both.

## 2. Creating the first administrator

The first super admin cannot be created in the console, because nobody can sign in yet. It is created with a
command on the server, with the API's environment loaded:

```bash
PLATFORM_ADMIN_PASSWORD='a-long-password-of-your-own' \
  pnpm --filter @typease/api platform-admin -- --email ops@example.com --name "Operations Lead"
```

- The password is read from the environment variable, never from the command line. It needs at least 14
  characters with an upper-case letter, a lower-case letter and a number.
- `--role SUPPORT_AGENT` creates a support agent instead (the default is `SUPER_ADMIN`).
- An email address that already belongs to a centre's account is refused.
- Running it again for an existing platform account sets a new password, re-enables the account and ends its
  sessions.
- The action is written to the platform audit log.

Everybody else is invited from the console (section 13). Do not use the demo accounts of the seed
(`admin@typease.test` and others) on anything but a development system.

## 3. Signing in

Open the platform console and sign in with your email address and password. The console is for TypEase
staff only; a centre's account is told to sign in to its own workspace.

**Two-step verification is required** for every platform account when the installation enforces it, which a
production installation must. The first time you sign in you are taken to **Set up two-step verification**:
install an authenticator app, scan the code, enter the 6-digit code and save the recovery codes.

Under your name: **My profile**, **Password and security** (password, two-step verification, devices signed
in), **Sign out**.

![Sign-in page of the platform console](../brand/screenshots/platform-sign-in-en-light-desktop.png)

## 4. Dashboard

For a super admin, **Platform overview** shows:

- **Centres by status**: active, in trial, suspended, setting up, awaiting approval, payment overdue,
  cancelled, archived.
- **Subscription revenue**: monthly and annual recurring revenue, the number of paying subscriptions, churn
  over the last 30 days. Recurring revenue is a run rate from active subscriptions after coupons, without
  tax. It is not money received.
- **Needs attention**: platform problems, centres waiting for approval, unpaid invoices with a failed
  attempt, trials ending within 7 days, open support tickets.
- Charts: sign-ups per month, subscription payments received per month, subscriptions by plan.
- **Usage this month** across all centres: document storage, requests, notifications, AI pages and their
  estimated cost, message deliveries per channel, and the centres with the largest storage use.

All of these are counts and amounts. No customer of any centre appears.

A support agent sees **Your work**: open tickets and their own access requests.

## 5. Centres

**Centres** lists every typing centre with its status, plan and subscription. The list shows centre-level
facts only.

### How do I add a centre for a customer?

**Add centre**. Enter the business name, the **Address part** (the short name used in the centre's web
address), the legal name, and the owner's name, **own** email address and mobile number. Optionally choose a
plan, the billing period and a coupon; without a plan the owner chooses one during set-up. The owner
receives an invitation by email and chooses their own password. A TypEase staff address is not accepted as
the owner's address.

Centres can also register themselves, unless the installation switched self-registration off
(`SELF_SIGNUP_ENABLED`).

### What does a centre's page show?

Tabs: **Overview**, **Billing**, **Feature flags**, **Support access**, **Audit trail**.

The overview has the lifecycle and status, **Usage against the plan**, **Owners** (with two-step
verification on or off, last sign-in), **Domains and white label**, **Set-up progress**, **Branches and
staff** (numbers), **Support** (open tickets with TypEase, access requests) and the centre's **Profile**
(contact details, trade licence number, tax registration number, time zone, currency, language).

### How do I approve a new centre?

When the installation requires approval (`TENANT_APPROVAL_REQUIRED=true`), a centre that finished its set-up
is **Waiting for your approval** and cannot be used yet.

- **Approve**: the centre can start working. From then on its status follows its subscription.
- **Reject sign-up**: the centre is suspended with your reason, which the owner can read. You can still
  approve it later by reactivating it.

What to check before approving is your own procedure; the console shows what the owner entered and nothing
else.

### How do I suspend or reactivate a centre?

- **Suspend**, with a reason: staff and customers of the centre are locked out from their next request. The
  owner can still sign in to read the reason. **A payment does not lift this suspension**; only
  **Reactivate** does.
- A centre **suspended because the subscription is unpaid** is handled in Billing: record the payment or
  extend the trial, and the centre comes back by itself. It cannot be reactivated here.
- **Send owner invitation again** sends a new link; the earlier one stops working.

Every status change is written to the platform audit log and to the centre's own audit trail.

## 6. Closing a centre and deleting its data

Two different actions.

**Close and archive.** Every session of the centre ends, nobody can sign in, its subscription is cancelled
and open subscription invoices are voided. **Nothing is deleted.** **Reactivate** brings the centre out of
the archive; the owner then has to subscribe again.

**Schedule deletion.** After a waiting period, every record and file of the centre is deleted for good.

1. **Agree the data export with the owner first.** Nothing is exported automatically, and once deletion is
   scheduled the owner can no longer sign in. While the centre is still active the owner can export reports,
   invoice and receipt PDFs and documents themselves. If the owner asks for a full data set, an operator
   produces it from the database during the waiting period; the procedure is in
   [api/modules/platform.md](../api/modules/platform.md), section 3. Record on the support ticket what was
   exported, for whom and when.
2. Choose **Schedule deletion**, type the centre's address part to confirm, give a reason, and set the
   **Days until the data is deleted**: at least 30, or the minimum set in the platform settings.
3. At once: the centre is archived, every session ends, its domains are switched off, open support access is
   revoked, its subscription is cancelled and open subscription invoices are voided.
4. On the day, a job deletes the centre's files and then every row of the centre in one transaction,
   including its audit entries. Accounts of people who belonged to no other centre are deleted too.
5. Kept: one platform audit entry stating that the centre was purged, with counts; earlier platform audit
   entries about the centre; and entries of the platform incident register that mention it.

**Cancel deletion** withdraws it before the date. The centre stays archived, and its domains have to be
verified again.

There is no undo, and the job takes no backup. **Database backups still contain the centre's data until they
expire by their own retention.** Tell the owner so if they ask what "deleted" means.

## 7. Subscriptions and billing

**Subscriptions** (super admin) lists what centres pay TypEase, with a tab for **Failed payments**. Open a
centre's **Billing** tab for its history, invoices and actions.

**TypEase stores no payment method.** An "attempt" reminds the centre; it does not charge a card. Centres pay
each invoice themselves, online if a platform payment gateway is configured, or by transfer.

| Action | What it does |
| --- | --- |
| **Record payment** | For money received outside the online gateway (bank transfer, cheque, cash) with a reference. It has the same consequences as an online payment: the period starts or the centre is reactivated |
| **Void** | The invoice can no longer be paid. Voiding an upgrade invoice withdraws the upgrade. Cannot be undone |
| **Extend trial** | Adds days to the trial end. Also brings back a centre whose trial ran out without ever paying |
| **Apply coupon** | Open period invoices are issued again with the discount. A centre can use a given coupon once |
| **Change plan** | A more expensive plan starts once its proration invoice is paid; a cheaper plan or another billing period starts at the end of the period. As a commercial decision you can switch at once without a charge for the rest of the period. A plan whose limits the centre already exceeds is refused |

How a subscription moves, with the default settings:

1. Trial (14 days in the default plans). Three days before it ends the owner is reminded. When it ends the
   first invoice is issued.
2. A renewal invoice is issued 7 days before each period ends.
3. Unpaid at the period end: **payment overdue**. Reminders follow after 1 day and again 2 days later.
4. Then a **grace period** of 7 days. The centre keeps working throughout.
5. Grace over: the subscription expires and the centre is **suspended for non-payment**. The invoice stays
   open. A payment at any point brings the centre back.

**To bring back a centre suspended for non-payment, fix its billing** (record the payment, extend the trial,
void and re-plan). Do not try to change the centre's status another way: an hourly job re-derives the status
from the subscription and would suspend it again.

Subscription invoices are numbered `TE-SUB-000001` and onwards. The tax rate on them is a platform setting
and is **0 by default**: set it under **Feature flags**, **Platform settings**, **Subscription billing**
after taking tax advice. The platform's own payment gateway has not been tested against the real provider.

## 8. Plans and coupons

**Plans** compares what each plan costs and includes: monthly and annual price, free trial, limits (branches,
staff users, requests per month, document storage, AI pages per month, notifications per month, corporate
clients) and features (own branding, own domain, corporate portal, automation rules, AI assistant,
scheduled reports). Centres see the same figures when they choose a plan.

![Plans compared](../brand/screenshots/platform-plans-en-light-desktop.png)

- The four default plans (Starter, Professional, Business, Enterprise) are created when the platform starts
  for the first time.
- **Add plan** (permission `platform.plans.manage`): key (2 to 40 lower-case letters, numbers or hyphens;
  cannot be changed later), name, description, monthly and annual price without tax, free trial in days,
  limits (-1 means unlimited, 0 means not part of the plan), features, and the two switches **On the sign-up
  page** (otherwise private: only staff can assign it) and **Offered** (otherwise no new subscriptions; current
  ones continue). A public, offered plan appears on the sign-up page at once.
- **Edit**: limits and features change at once for every centre on the plan; a new price applies from each
  centre's next invoice. The dialog says how many centres are on the plan before you confirm.
- **Delete plan** is possible only for a plan that never had a subscriber; otherwise stop offering it.
- There is no "API access" feature: it was retired because no part of the software provides an API for
  third parties. Older plan records that still carry the flag are read without it.

**Coupons**: **Create coupon** with a code, a percentage or an amount off, how many months it applies, how
often it can be used, which plans it is for and its validity dates. The discount is fixed once the coupon
exists, because it may already be in use; **Change availability** edits the rest. **Deactivate** stops new
uses. Only a coupon that was never used can be deleted.

## 9. Support tickets from centres

**Support** shows the questions centres raise with TypEase. You see the conversation and the centre, never
the centre's customers. The tickets customers raise with their centre are not visible here at all.

- Reply to the centre, or add a note that only TypEase staff can see.
- **Resolve**: the centre is told. A reply from the centre reopens the ticket. **Close**: a closed ticket
  cannot be reopened or answered.
- **Need to look at the centre's data?** starts an access request that is linked to the ticket (section 10).

The centre is notified of your reply by email if email delivery is configured.

## 10. Access to a centre's data

**Access requests** shows who asked which centre for access, why, for how long, and what the centre decided.

### How do I ask?

**Request access**. Choose the centre, write the **reason** (the owner reads it), tick the **scope**, and set
the duration (5 minutes to 24 hours, or less if the platform settings say so). **Send request**.

Scopes you can ask for. All are read-only:

| Scope | Covers |
| --- | --- |
| Customers | Customer profiles. Identity numbers stay masked |
| Service catalogue | Services, prices and required documents |
| Requests | Every service request with its status and timeline |
| Internal comments | The staff-only comments on requests |
| Quotations, Invoices, Payments | The centre's documents and payments with its customers |
| Branches, Staff | Locations, staff members and their roles |
| Appointments, Tasks, Reminders | As named |
| Customer tickets | Support tickets customers raised with the centre |
| Operational reports | Workload and turnaround reports |
| Audit trail | The centre's own audit entries |
| **Document files** | Opens the files customers uploaded: passports, IDs, certificates. **Ask only when nothing else will do** |

### What happens then?

- The people at the centre who may decide (the owner by default) are told by email and in the application.
  They approve or deny, and may approve fewer scopes or a shorter time.
- A request nobody answers lapses (after 7 days by default). You are told by email when the centre decides
  or ends the access, if email delivery is configured. You are not told when a request lapses or an access
  runs out.
- An approved access is read-only, starts when it is approved, ends by itself, and can be ended by the centre
  at any moment. **Withdraw request** and **End access now** are yours to use at any time.
- Every step, and everything done under the access, is written to the centre's audit trail with the label
  "TypEase support". Opening a document is recorded separately.
- One open request or active access per staff member and centre.

### How do I look at the data once the centre approved?

Open the access request and choose **Enter centre** (shown only to the person who asked, while the access is
running). The centre's staff application opens in a new tab and signs you in by itself for the approved scope
and time; the console records that you entered. If the browser blocks the new tab, allow pop-ups for the
console and press the button again (the code of the first attempt is no longer valid).

How it works: the console asks the API for a one-time code (`POST /platform/access-grants/:id/enter`) and
opens the staff app's `/support-session` page with it; that page exchanges the code for a session of its own
within 60 seconds. No token travels in the address bar.

Things to know about a support session:

- It is bound to that one centre and cannot use the platform console's functions; the staff app shows a
  permanent banner naming the centre, the scope and the end time.
- It reaches only routes that one of the approved scopes opens; everything else is refused, including most
  things an ordinary member can read. The exceptions are the session itself, the centre's profile, its
  feature flags, the document type names and the branch directory.
- It is read-only. With the scope "Internal comments" it can also **write** an internal note on a request;
  that is the only change it can make.
- It sees all branches of the centre.
- Every call that reaches the centre's data, allowed or refused, is written to the centre's audit trail.

## 11. Authorisation reviews and approved providers

**Integrations** (super admin) has three tabs: **Platform providers**, **Authorisation reviews** and
**Approved providers**. A centre's own connections and credentials are never visible here.

### Platform providers

**What this installation is configured to use** (`GET /platform/system/providers`): one row per outside
dependency of the platform itself - e-mail, SMS, WhatsApp Business, push notifications, object storage,
malware scanner, document reading (OCR), online payments and the payment test adapter, automation webhooks
(n8n), Redis, background jobs, error tracking - with the driver and a status: **Configured**, **Not
configured**, **Log only, not delivered**, **Switched off** or **Test adapter only**. The rows are read from
the API's environment; only object storage and Redis are really contacted, every other row says what is
configured, not that it works. No secret is shown. In the environment this software was built in every
external provider showed "Not configured" or "Log only".

### Authorisation reviews

Centres that submit applications themselves, or through a partner, record that in an **authorisation
record**: the authority or partner, a reference, validity dates and who holds the portal account. Only a
verified record lets the centre mark a service as "Direct authorised processing". Records wait here for
review, oldest first.

- **Verify**: the centre can then offer the services that need this authorisation. Your name, the time and
  your note are stored.
- **Reject**: the record stays switched off. Say what is missing.
- **Withdraw verification**: the record is switched off at once, and the services that need it can no longer
  be offered.

If the centre attached evidence, it is in the centre's document vault. Opening it needs support access with
the "Document files" scope that the centre approves (and see section 10 on how that currently works).
Otherwise ask the centre for the licence or agreement through a support ticket before you verify.

**Read this carefully.** Verifying is a statement by you, a person, that you looked at the evidence. The
software does not check anything with any authority and cannot. Your organisation needs a written procedure
for what evidence is required and who may verify, and it is responsible for the decision. TypEase itself
holds no government authorisation and connects to no government system; a record never contains portal
credentials.

### Approved providers

Which outside providers centres may set up (payment, email, SMS, WhatsApp, push, automation). A provider that
is not approved cannot be added or switched on by a centre. Removing a provider from the list switches it off
in every centre at once, with an entry in each centre's audit trail.

## 12. Feature flags and platform settings

**Feature flags** (super admin).

- **Feature flags**: switch a feature on or off for every centre, or for one centre. **Add flag** creates a
  flag; the key is what the code asks for and cannot be renamed. A setting made for one centre (on the
  centre's **Feature flags** tab) wins over the platform default. A flag only has an effect if the code asks
  for it.
- **Platform settings**: three groups of policies.

| Group | Settings | Default |
| --- | --- | --- |
| **Subscription billing** | Renewal invoice, days before the period ends; trial reminder, days before the trial ends; days between collection attempts; grace period in days; tax rate on subscription invoices | 7; 3; 1 and 2; 7; 0 |
| **Support access** | Longest access in minutes; unanswered requests lapse after days | 1440; 7 |
| **Deleting closed centres** | Shortest waiting time in days | 30 (cannot be set lower) |

New values apply to every centre from then on. Each change is recorded. Resetting removes the stored values
so that the built-in defaults apply again.

Technical settings of the installation (secrets, providers, storage, rate limits) are environment variables,
not console settings; see [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md).

## 13. Platform staff

**Staff** (super admin) lists TypEase staff accounts with their role, two-step verification and last sign-in.

- **Invite staff**: full name, work email and role. They receive a link, valid for 72 hours, to choose their
  password, and set up two-step verification at their first sign-in.
- **Change role**: applies from their next request and is recorded as a security event.
- **Disable account**: they are signed out everywhere at once, and every support access they asked for or
  held is closed. **Enable account** reverses it.
- Nobody can change, disable or enable their own account, and there is always at least one active super
  admin.

Give the super admin role to as few people as possible. Review this list, and the list of approved support
accesses, regularly.

## 14. Audit and security

**Audit & security** (super admin) has four tabs.

- **Audit log**: what TypEase staff and platform jobs did. Open an entry for the details. Entries cannot be
  changed.
- **Security events** across the platform: failed sign-ins, lockouts, two-step failures, reuse of a refresh
  token, password resets, centre status changes, support access, invalid webhook signatures, blocked uploads
  and malware findings, failed purges. **Nobody is alerted about these. Somebody has to look**, regularly.
- **Incident register**: for incidents that concern TypEase as a whole. **Record incident**, then move it
  through open, investigating, contained and resolved. Resolving needs notes; if personal data is involved
  the notification decision must be recorded first, and a required notification must have a date. **The
  register records facts and decisions. It notifies nobody and does not judge whether a notification is
  legally required.** A centre records its own incidents in its workspace, and those are not visible here.
- **Processor register**: the outside companies that process personal data for the platform, with purpose,
  data categories and country. **Add processor**, then **Approve** or **Reject** after review. A processor
  outside the UAE cannot be approved without recorded safeguards. **The register is a record of decisions.
  It does not switch any integration on or off.**

## 15. System health

**System health** (super admin; `GET /platform/system/health`) shows what the platform runs on, as the API
checks it at that moment: the API, the database (application connection and system connection), Redis
(rate limits, short-lived caches and the job queue), object storage (reachable or not, with the target and
the last error), the background worker (**Reporting**, **Stale: not heard from**, **Switched off** for an
inline queue without autorun, or never reported), the job queue (waiting, failed and stalled jobs), the
event outbox (events waiting to be delivered to notifications, reminders and automations) and message
deliveries per channel this month. Problems are listed at the top ("The database is not answering", "No
background worker has ever reported: start the worker process", "Events have been waiting for ... minutes"). A
rising share of failed deliveries usually means a provider problem.

The page is a point-in-time check from inside the API. It is not a monitoring system: if the API is down,
the page is down. Alerting belongs to the monitoring stack described in
[deployment/monitoring.md](../deployment/monitoring.md), which has not been run in the environment this
software was built in.

## 16. Things the console does not do

| Not available | What to do instead |
| --- | --- |
| Exporting a centre's data | Manual procedure (section 6) |
| Exporting platform reports to Excel or PDF | Not implemented |
| Editing a centre's services, staff, branding or settings | Not possible, by design. The centre does this |
| Releasing a custom domain held by a centre | No console button. An unverified claim is released by itself after 72 hours and removed after 14 days; a verified domain is released only through the API (`GET /platform/domains` to find it, `DELETE /platform/domains/:id` with a reason, permission `platform.tenants.manage`; audited on both trails). The centre page lists a centre's domains |
| Editing the privacy policy and terms text of the portals | It is in the portal's translation files; changing it needs a rebuild |
| Rotating the data encryption key | Not from the console: it is an operator procedure with `DATA_ENCRYPTION_KEY_ID`, `DATA_ENCRYPTION_OLD_KEYS` and the `reencrypt` command ([deployment/secrets.md](../deployment/secrets.md), section 5) |
| Restoring a single centre from a backup | Not available; backups are of the whole database |
| Alerts on security events | Not implemented; review them by hand |
| Any connection to a government system | Does not exist |

Related: [TENANT_ISOLATION.md](../TENANT_ISOLATION.md), section 5;
[DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md); [SECURITY_CHECKLIST.md](../SECURITY_CHECKLIST.md), section 25;
[UAE_COMPLIANCE_REVIEW.md](../UAE_COMPLIANCE_REVIEW.md), section 9.
