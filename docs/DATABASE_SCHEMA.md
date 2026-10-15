# Database schema

PostgreSQL schema of TypEase: every table with its purpose, columns, tenant scope and the rules the database
itself enforces. It is for engineers changing the data model, operators running migrations and reviewers
checking tenant isolation.

The tables in sections 3 and 4 and the constraint list in section 5.2 were produced by a script from
`database/prisma/schema.prisma`, `database/migrations/*.sql` and `database/scripts/rls-config.ts`; the purpose
column and the prose were written by hand. Section 8 shows how to check that the document still covers every
table and enum.

Related documents: [TENANT_ISOLATION.md](TENANT_ISOLATION.md) (how the roles and policies are used),
[ARCHITECTURE.md](ARCHITECTURE.md), [security/BACKUP_AND_RECOVERY.md](security/BACKUP_AND_RECOVERY.md),
[deployment/upgrades-and-rollbacks.md](deployment/upgrades-and-rollbacks.md).

## Contents

1. [Conventions](#1-conventions)
2. [Database roles, grants and scope classes](#2-database-roles-grants-and-scope-classes)
3. [Tables by domain](#3-tables-by-domain)
4. [Enums](#4-enums)
5. [Integrity rules from the migrations](#5-integrity-rules-from-the-migrations)
6. [Numbering](#6-numbering)
7. [Migration procedure](#7-migration-procedure)
8. [Checking and regenerating this document](#8-checking-and-regenerating-this-document)

## 1. Conventions

| Topic | Rule |
| --- | --- |
| Size | 107 tables (plus the runner's own `schema_migrations`) and 53 enum types. One PostgreSQL schema, `public`. PostgreSQL 15 or newer is required (`NULLS NOT DISTINCT`); the project was built on 16. |
| Names | Tables are snake_case (`@@map` in the Prisma schema). Columns keep their camelCase names, so raw SQL must quote them: `"tenantId"`. |
| Keys | Every primary key is a UUID (`gen_random_uuid()`, extension `pgcrypto`), except `permissions.key` and `platform_settings.key`. There are no serial columns and no PostgreSQL sequence objects. |
| Tenant column | 86 tables have a mandatory `tenantId`, 15 a nullable one (a row without a tenant belongs to the platform) and 6 have none. Shared database, shared schema: TypEase does not give each centre its own database. |
| Money | `DECIMAL(14,2)` with an ISO 4217 `currency` column. The API returns money as strings; no floating point is used. |
| Time | `TIMESTAMPTZ(3)`, stored in UTC. Sessions of both runtime roles are pinned to UTC. Calendar dates without a time are `DATE`. |
| JSON | `JSONB` for settings, snapshots and payloads (`tenants.settings`, `service_requests.serviceSnapshot`, `outbox_events.payload` ...). |
| Actor columns | `createdById`, `decidedById`, `verifiedById` and similar are soft references to `users.id` without a foreign key, on purpose: audit and financial history must survive the removal of a user. |
| Soft delete | `deletedAt` on `users`, `customers`, `corporate_accounts`, `services`, `service_requests`, `documents`, `expenses`. Financial tables have no delete at all (section 5). |
| Optimistic locking | `version` on `customers`, `services`, `service_requests`, `quotations`, `invoices`. |
| Foreign keys | 203 foreign-key constraints: 148 `ON DELETE CASCADE` (children of a tenant or of an aggregate), 32 `SET NULL`, 23 `RESTRICT`. |
| ORM | Prisma is the typed client only. `prisma migrate` is not used; see section 7. |

## 2. Database roles, grants and scope classes

### 2.1 The three roles

| Role | Used by | Connection variable | Row-level security | Privileges |
| --- | --- | --- | --- | --- |
| `typease_owner` | the migration runner, backups, `scripts/production-readiness.mjs` | `DATABASE_MIGRATION_URL` | owns the tables, so policies do not apply to it (`FORCE ROW LEVEL SECURITY` is not set) | everything; needs `CREATEROLE` for the first migration; must not be a superuser |
| `typease_app` | every tenant request and every tenant job (`TenantDb`) | `DATABASE_URL` | enforced: sees only rows of the tenant bound to the transaction | per-table grants below; never superuser, never `BYPASSRLS`, owns nothing |
| `typease_system` | cross-tenant code only (`SystemDb`): sign-in, tenant resolution, billing, webhooks intake, platform console, schedulers | `DATABASE_SYSTEM_URL` | policy `system_access ... USING (true)` on every table | `SELECT, INSERT, UPDATE, DELETE` on every table |

The two runtime roles are created by migration `0002` without a password and without login. The migration
runner then sets their passwords from `DATABASE_URL` / `DATABASE_SYSTEM_URL`, sets their time zone to UTC, and
aborts if `typease_app` is a superuser or has `BYPASSRLS`. The role names are fixed: the runner refuses a URL
whose user is not `typease_app` / `typease_system`.

The API refuses to start in production when its tenant connection can bypass row-level security
(`TenantDb.onModuleInit`); outside production it logs an error and continues.

### 2.2 Scope classes

Row-level security is enabled on all 107 tables. What `typease_app` can reach depends on the class of
the table (`database/scripts/rls-config.ts`):

| Class | Tables | Policy for `typease_app` |
| --- | --- | --- |
| **tenant** (90 tables) | every table with a `tenantId` that is not listed below | `tenant_isolation`: `USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id())`. Four of these tables have a nullable `tenantId` (`outbox_events`, `audit_logs`, `security_events`, `integration_credentials_metadata`): their platform-level rows never match and are invisible to centres. |
| **shared-readable** (5) | `roles`, `role_permissions`, `feature_flags`, `document_types`, `notification_templates` | `tenant_isolation` as above, plus `shared_read`: `FOR SELECT USING ("tenantId" IS NULL)`. Rows without a tenant are platform defaults every centre may read and none may change. At the time of writing such rows exist for `document_types` and `notification_templates` (and for `feature_flags` once a platform administrator sets a global default); `roles` and `role_permissions` have none, because roles are provisioned per centre. |
| **global-readable** (4) | `permissions`, `subscription_plans`, `authority_fees`, `authority_fee_changes` | `global_read`: `FOR SELECT USING (true)`; grant is `SELECT` only. |
| **system-only** (8) | `sessions`, `auth_tokens`, `login_activity`, `coupons`, `platform_settings`, `payment_webhook_events`, `security_incidents`, `processor_records` | no grant and no policy: a tenant connection gets "permission denied". |
| **users** | `users` | `SELECT` on the listed safe columns only (no password hash, MFA secret, recovery hashes or lockout counters); policy `tenant_visible`: the user's own row, or users who have a membership in the bound tenant. |
| **tenants** | `tenants` | `SELECT`, and `UPDATE` of the self-service columns only (`name`, `legalName`, `emirate`, `timezone`, `defaultLanguage`, contact fields, licence and tax numbers, `taxRatePercent`, `aiEnabled`, onboarding fields, `settings`); policy `id = app_tenant_id()`. Status, approval, suspension and offboarding columns are platform-controlled. |

`app_tenant_id()` and `app_user_id()` read the transaction-local settings `app.tenant_id` and `app.user_id`,
which `TenantDb.tx()` sets as the first statement of every transaction. Without them both functions return
NULL and no tenant row is visible.

### 2.3 Tables where the tenant role has less than full access

Every other tenant table is granted `SELECT, INSERT, UPDATE, DELETE` (always inside the tenant policy).

| Table | `typease_app` may |
| --- | --- |
| `permissions` | SELECT |
| `subscription_plans` | SELECT |
| `subscriptions` | SELECT |
| `subscription_invoices` | SELECT |
| `subscription_events` | SELECT |
| `tenant_domains` | SELECT, INSERT, DELETE |
| `feature_flags` | SELECT |
| `request_status_history` | SELECT, INSERT |
| `document_access_logs` | SELECT, INSERT |
| `ai_usage_logs` | SELECT, INSERT |
| `invoices` | SELECT, INSERT, UPDATE |
| `payments` | SELECT, INSERT, UPDATE |
| `payment_allocations` | SELECT, INSERT |
| `refunds` | SELECT, INSERT, UPDATE |
| `credit_notes` | SELECT, INSERT, UPDATE |
| `liability_entries` | SELECT, INSERT |
| `outbox_events` | SELECT, INSERT |
| `audit_logs` | SELECT, INSERT |
| `security_events` | SELECT, INSERT |
| `access_grants` | SELECT, UPDATE |
| `consent_records` | SELECT, INSERT |
| `integration_logs` | SELECT, INSERT |

Reading the list: billing state (`subscriptions`, `subscription_invoices`, `subscription_events`) and feature
flags are changed only on the system connection; a centre may add or remove a domain but cannot write its
verification state; a centre may decide a support access grant but cannot create one; invoices, payments,
refunds and credit notes are never deleted; the log-like tables only accept inserts.

## 3. Tables by domain

Scope values are the classes of section 2.2. "Cross-tenant guard" names the foreign-key columns checked by
the `same_tenant_guard` trigger (section 5.5).

### 3.1 Identity and sessions

Platform-wide accounts. A person has one `users` row whatever the number of centres they belong to; everything a centre may see of it goes through a membership.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `users` | One row per person who can sign in: staff, customers, company users and TypEase staff (`platformRole`). Holds the Argon2id password hash, the encrypted TOTP secret and recovery-code hashes, and the lockout counters. | `email`, `emailVerifiedAt`, `phone`, `phoneVerifiedAt`, `passwordHash`, `fullName`, `preferredLanguage`, `platformRole` (PlatformRole), `status` (UserStatus), `mfaEnabled`, `mfaSecretEnc`, `mfaRecoveryHashes`, `failedLoginCount`, `lockedUntil`, `lastLoginAt`, `passwordChangedAt`, `deletedAt` | special: users | unique: `email`; `phone`; check: `users_email_lowercase`, `users_phone_e164`; `typease_app`: SELECT (listed columns) |
| `sessions` | One row per refresh token (stored as SHA-256). `familyId` links the rotations of one sign-in; a support session carries `supportGrantId`. | `userId`, `membershipId`, `app`, `refreshTokenHash`, `familyId`, `supportGrantId`, `mfaVerified`, `userAgent`, `ip`, `deviceName`, `lastUsedAt`, `expiresAt`, `revokedAt`, `revokedReason` | system-only | unique: `refreshTokenHash`; no grant to `typease_app` |
| `auth_tokens` | One-time secrets: email verification, password reset, phone OTP, MFA challenge, centre selection, invitations. Only a hash is stored; attempts are counted. | `userId`, `type`, `tokenHash`, `target`, `attempts`, `maxAttempts`, `meta`, `expiresAt`, `consumedAt` | system-only | no grant to `typease_app` |
| `login_activity` | Every sign-in attempt with result, reason, app, IP and user agent. | `userId`, `email`, `app`, `success`, `reason`, `ip`, `userAgent` | system-only | no grant to `typease_app` |

### 3.2 Tenancy and organisation

The centre (tenant), its branches, and who works there with which role.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `tenants` | The typing centre: slug, status, time zone, currency, tax rate and tax registration number, the JSON `settings` (numbering prefix, validity days, appointment and queue settings ...), onboarding progress, suspension and offboarding dates. | `slug`, `name`, `legalName`, `status` (TenantStatus), `country`, `emirate`, `timezone`, `defaultCurrency`, `defaultLanguage`, `contactEmail`, `contactPhone`, `tradeLicenceNo`, `taxRegistrationNo`, `taxRatePercent`, `aiEnabled`, `onboardingStep`, `onboardingData`, `settings`, `approvedAt`, `approvedById`, `suspendedAt`, `suspensionReason`, `archivedAt`, `offboardingAt` | special: tenants | unique: `slug`; check: `tenants_slug_format`, `tenants_tax_rate_range`, `tenants_currency_iso`; `typease_app`: SELECT + UPDATE (listed columns) |
| `roles` | Roles of a centre (the nine system roles are provisioned per centre; the owner may change every one of them, delete unused staff roles and add custom staff roles) and a company's own roles in the corporate portal (`corporateAccountId` set: the company's copies of the two company roles, `isSystem`, and roles it created; keys `co_<company id>_...`). Rows without a tenant are reserved for platform defaults. | `key`, `name`, `description`, `kind` (MembershipKind), `isSystem`, `corporateAccountId` | shared-readable | unique: `tenantId + key`; the unique key treats NULL as a value (`NULLS NOT DISTINCT`); a company role is always `CORPORATE` (check `roles_company_kind`); cross-tenant guard on `corporateAccountId` (migration `0013`) |
| `permissions` | The permission catalogue (85 tenant + 11 platform keys), written at start-up from `packages/permissions`. | `key`, `groupName`, `description` | global-readable | `typease_app`: SELECT |
| `role_permissions` | Which permission a role holds. | `roleId`, `permissionKey` | shared-readable | unique: `roleId + permissionKey`; cross-tenant guard on `roleId` |
| `tenant_memberships` | Links a user to a centre with a role and a kind (`STAFF`, `CUSTOMER`, `CORPORATE`). Customer memberships point at the customer record, corporate ones at the company (and optionally the employee). | `userId`, `roleId`, `kind` (MembershipKind), `status` (MembershipStatus), `customerId`, `corporateAccountId`, `corporateEmployeeId`, `allBranches`, `jobTitle`, `isAvailable`, `invitedById`, `invitedAt`, `joinedAt` | tenant | unique: `tenantId + userId + kind`; cross-tenant guard on `roleId`, `customerId`, `corporateAccountId`, `corporateEmployeeId` |
| `membership_branches` | The branches a staff member is limited to when `allBranches` is false. | `membershipId`, `branchId` | tenant | unique: `membershipId + branchId`; cross-tenant guard on `membershipId`, `branchId` |
| `staff_schedules` | Weekly working hours of a staff member per branch (used by automatic assignment and appointment capacity). | `membershipId`, `branchId`, `weekday`, `startTime`, `endTime`, `isActive` | tenant | cross-tenant guard on `membershipId`, `branchId`; check: `staff_schedules_weekday` |
| `staff_skills` | Services a staff member is skilled in (automatic assignment prefers them). | `membershipId`, `serviceId` | tenant | unique: `membershipId + serviceId`; cross-tenant guard on `membershipId`, `serviceId` |
| `branches` | Branches of a centre with address, time zone and opening hours. Exactly one head office. | `code`, `name`, `nameAr`, `address`, `emirate`, `phone`, `email`, `timezone`, `isHeadOffice`, `isActive`, `workingHours` | tenant | unique: `tenantId + code`; partial unique index `branches_one_head_office` (WHERE isHeadOffice) |

### 3.3 SaaS billing, branding and platform configuration

The money between a centre and TypEase, plan limits, and per-centre presentation. Completely separate from customer finance.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `subscription_plans` | Plans with prices, trial length, `limits` and `features` (JSON). Four starting plans are inserted when the table is empty. | `key`, `name`, `description`, `monthlyPrice`, `annualPrice`, `currency`, `trialDays`, `limits`, `features`, `isPublic`, `isActive`, `sortOrder` | global-readable | unique: `key`; check: `subscription_plans_prices`; `typease_app`: SELECT |
| `coupons` | Discount codes for subscriptions. | `code`, `description`, `percentOff`, `amountOff`, `currency`, `durationMonths`, `maxRedemptions`, `redeemedCount`, `planKeys`, `validFrom`, `validUntil`, `isActive` | system-only | unique: `code`; check: `coupons_one_kind`; no grant to `typease_app` |
| `subscriptions` | The one subscription of a centre: plan, status, billing period, trial / grace dates, pending plan or cycle, applied coupon. | `planId`, `status` (SubscriptionStatus), `billingCycle` (BillingCycle), `currentPeriodStart`, `currentPeriodEnd`, `trialEndsAt`, `graceEndsAt`, `cancelAtPeriodEnd`, `cancelledAt`, `cancellationReason`, `pendingPlanId`, `pendingCycle` (BillingCycle), `couponId`, `couponEndsAt`, `gatewayCustomerRef`, `renewalReminderAt` | tenant | unique: `tenantId`; check: `subscriptions_period_order`; `typease_app`: SELECT |
| `subscription_invoices` | Invoices from TypEase to a centre, numbered `TE-SUB-000001` globally. | `subscriptionId`, `number`, `status` (SubscriptionInvoiceStatus), `reason`, `periodStart`, `periodEnd`, `subtotal`, `discount`, `tax`, `total`, `currency`, `lines`, `dueAt`, `paidAt`, `paymentMethod`, `gatewayRef`, `attemptCount`, `nextAttemptAt`, `lastError` | tenant | unique: `number`; cross-tenant guard on `subscriptionId`; check: `subscription_invoices_amounts`; `typease_app`: SELECT |
| `subscription_events` | Billing history: every transition of a subscription, with data. | `subscriptionId`, `type`, `data`, `actorId` | tenant | `typease_app`: SELECT |
| `usage_records` | Counters against plan limits: monthly (`monthlyRequests`, `notifications`, `aiPages`) and the running total `storageBytes`. | `metric`, `periodKey`, `quantity` | tenant | unique: `tenantId + metric + periodKey` |
| `tenant_domains` | Custom domains of a centre with the DNS verification token and status. A domain is globally unique. | `domain`, `kind`, `app`, `verificationToken`, `status` (DomainStatus), `verifiedAt`, `lastCheckedAt`, `lastCheckError`, `isPrimary`, `createdById` | tenant | unique: `domain`; partial unique index `tenant_domains_one_primary` (WHERE isPrimary); check: `tenant_domains_lowercase_fqdn`; `typease_app`: SELECT, INSERT, DELETE |
| `branding_settings` | White-label settings: mode, names, colours, logo and favicon keys, support contact, email sender, invoice / receipt footers. One row per centre plus optional rows per branch. | `branchId`, `mode`, `businessName`, `businessNameAr`, `logoAssetKey`, `faviconAssetKey`, `primaryColor`, `secondaryColor`, `accentColor`, `websiteTitle`, `tagline`, `supportEmail`, `supportPhone`, `emailFromName`, `emailFromAddress`, `emailSenderVerified`, `invoiceFooter`, `receiptFooter`, `publicCatalogueEnabled`, `updatedById` | tenant | unique: `tenantId + branchId`; the unique key treats NULL as a value (`NULLS NOT DISTINCT`); cross-tenant guard on `branchId`; check: `branding_hex_colours` |
| `feature_flags` | Feature switches: a global default (no tenant) and per-centre overrides. | `key`, `enabled`, `payload` | shared-readable | unique: `key + tenantId`; the unique key treats NULL as a value (`NULLS NOT DISTINCT`); `typease_app`: SELECT |
| `platform_settings` | Platform policies (allow-listed keys) and the subscription invoice counter. | `key`, `value` | system-only | no grant to `typease_app` |
| `number_sequences` | Gap-free counters per centre and key (customer, request, invoice ..., and the daily queue counters). | `key`, `nextValue` | tenant | unique: `tenantId + key`; check: `number_sequences_positive` |

### 3.4 Customers and companies

People and companies a centre serves.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `customers` | Customer profile. Identity numbers are stored three ways only: AES-256-GCM ciphertext (`*Enc`), keyed blind index (`*Hash`) and the last four characters (`*Last4`). | `customerNo`, `type` (CustomerType), `status` (CustomerStatus), `fullName`, `fullNameAr`, `preferredLanguage`, `email`, `phone`, `nationality`, `dateOfBirth`, `address`, `emiratesIdEnc`, `emiratesIdHash`, `emiratesIdLast4`, `emiratesIdExpiry`, `passportNoEnc`, `passportNoHash`, `passportNoLast4`, `passportCountry`, `passportExpiry`, `corporateAccountId`, `communicationPrefs`, `marketingOptIn`, `mergedIntoId`, `lastActivityAt`, `createdById`, `deletedAt`, `version` | tenant | unique: `tenantId + customerNo`; cross-tenant guard on `corporateAccountId`, `mergedIntoId` |
| `customer_contacts` | Additional email / phone / WhatsApp contacts, one primary per type. | `customerId`, `type`, `value`, `label`, `isPrimary` | tenant | cross-tenant guard on `customerId` |
| `customer_consents` | Current consent state per customer and purpose. | `customerId`, `purpose`, `status` (ConsentStatus), `lawfulBasis`, `noticeVersion`, `grantedAt`, `withdrawnAt` | tenant | unique: `customerId + purpose`; cross-tenant guard on `customerId` |
| `customer_notes` | Internal staff notes about a customer. | `customerId`, `authorId`, `body`, `isPinned` | tenant | cross-tenant guard on `customerId` |
| `customer_tags` | Internal labels of a centre. | `name`, `color` | tenant | unique: `tenantId + name` |
| `customer_tag_assignments` | Which customer carries which tag. | `customerId`, `tagId` | tenant | unique: `customerId + tagId`; cross-tenant guard on `customerId`, `tagId` |
| `corporate_accounts` | Company accounts: trade licence, billing details, proposed and approved credit terms, verification. | `accountNo`, `companyName`, `companyNameAr`, `tradeLicenceNo`, `tradeLicenceAuthority`, `tradeLicenceExpiry`, `taxRegistrationNo`, `billingEmail`, `billingAddress`, `paymentTermsDays`, `creditLimit`, `creditApproved`, `status` (CorporateStatus), `verifiedById`, `verifiedAt`, `notes`, `deletedAt` | tenant | unique: `tenantId + accountNo`; check: `corporate_accounts_terms` |
| `corporate_members` | Authorised contacts of a company (portal administrators). | `corporateAccountId`, `userId`, `fullName`, `email`, `phone`, `role`, `isAuthorisedSignatory`, `status` | tenant | unique: `corporateAccountId + email`; cross-tenant guard on `corporateAccountId` |
| `corporate_employees` | Employee directory of a company; each employee is backed by a customer record. | `corporateAccountId`, `customerId`, `employeeNo`, `designation`, `status` | tenant | unique: `corporateAccountId + customerId`; cross-tenant guard on `corporateAccountId`, `customerId` |
| `corporate_agreements` | Free-form records of what was agreed with a company. | `corporateAccountId`, `title`, `terms`, `startsOn`, `endsOn`, `status` | tenant | cross-tenant guard on `corporateAccountId` |
| `corporate_prices` | Contract price per company and service (replaces the service fee only). | `corporateAccountId`, `serviceId`, `serviceFee` | tenant | unique: `corporateAccountId + serviceId`; cross-tenant guard on `corporateAccountId`, `serviceId`; check: `corporate_prices_non_negative` |

### 3.5 Service catalogue and workflow definitions

What a centre sells and how a case moves.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `service_categories` | Categories of a centre (twelve defaults are created at provisioning). | `key`, `name`, `nameAr`, `description`, `icon`, `sortOrder`, `isActive` | tenant | unique: `tenantId + key` |
| `document_types` | Document types: platform defaults (no tenant) and the centre's own or overriding types. | `key`, `name`, `nameAr`, `hasExpiry`, `ocrProfile`, `reminderEnabled`, `isActive` | shared-readable | unique: `tenantId + key`; the unique key treats NULL as a value (`NULLS NOT DISTINCT`) |
| `services` | Services with compliance capability, payment policy, tax mode, visibility and the workflow to use. | `categoryId`, `code`, `name`, `nameAr`, `description`, `descriptionAr`, `eligibilityGuidance`, `complianceCapability` (ComplianceCapability), `estimatedProcessingHours`, `requiresApproval`, `paymentPolicy`, `depositPercent`, `taxMode`, `onlineAvailable`, `isPublic`, `isActive`, `allBranches`, `staffGroupRoleKey`, `workflowDefinitionId`, `sortOrder`, `deletedAt`, `version` | tenant | unique: `tenantId + code`; cross-tenant guard on `categoryId`, `workflowDefinitionId`; check: `services_payment_policy`, `services_tax_mode`, `services_deposit_percent` |
| `service_branches` | Branches a service is offered at when it is not offered everywhere. | `serviceId`, `branchId` | tenant | unique: `serviceId + branchId`; cross-tenant guard on `serviceId`, `branchId` |
| `service_prices` | Price history: default and per-branch service fee plus government and third-party fee estimates. | `serviceId`, `branchId`, `serviceFee`, `governmentFeeEstimate`, `thirdPartyFeeEstimate`, `currency`, `validFrom`, `validTo`, `isActive` | tenant | cross-tenant guard on `serviceId`, `branchId`; check: `service_prices_non_negative` |
| `authority_fees` | Authority fee catalogue maintained by TypEase (migration 0009): government and typing-channel fees of common transactions. Centres link services to entries (`services.authorityFeeId`, `services.authorityFeeVersion` = version last applied) and apply updates when they choose. | `authority`, `code`, `name`, `nameAr`, `category`, `governmentFee`, `thirdPartyFee`, `notes`, `sourceUrl`, `verifiedAt`, `isSample`, `isActive`, `version`, `updatedById` | global-readable | unique: `code`; check: `authority_fees_amounts`; written by platform staff only |
| `authority_fee_changes` | History of amount changes of an authority fee, one row per new version. | `feeId`, `version`, `governmentFeeBefore`, `governmentFeeAfter`, `thirdPartyFeeBefore`, `thirdPartyFeeAfter`, `note`, `changedById` | global-readable | unique: `feeId + version`; `typease_system`: SELECT, INSERT |
| `service_requirements` | The document checklist template of a service. | `serviceId`, `documentTypeKey`, `label`, `labelAr`, `description`, `isMandatory`, `allowReuse`, `maxAgeDays`, `sortOrder` | tenant | cross-tenant guard on `serviceId` |
| `service_form_definitions` | Versioned dynamic form of a service (`schema` JSON); at most one published version. | `serviceId`, `version`, `status` (PublishStatus), `schema`, `publishedAt`, `createdById` | tenant | unique: `serviceId + version`; partial unique index `service_form_definitions_one_published` (WHERE status = 'PUBLISHED'); cross-tenant guard on `serviceId` |
| `workflow_definitions` | Named workflows of a centre. | `key`, `name`, `description`, `templateKey`, `publishedVersionId` | tenant | unique: `tenantId + key` |
| `workflow_versions` | Versions of a workflow; at most one published, published versions are immutable (API rule). | `definitionId`, `version`, `status` (PublishStatus), `notes`, `publishedAt`, `publishedById`, `createdById` | tenant | unique: `definitionId + version`; partial unique index `workflow_versions_one_published` (WHERE status = 'PUBLISHED'); cross-tenant guard on `definitionId` |
| `workflow_steps` | Ordered steps of a version with type, conditions, branches, roles and time limits. | `versionId`, `key`, `name`, `nameAr`, `type` (WorkflowStepType), `position`, `config`, `conditions`, `branches`, `nextStepKey`, `onRejectStepKey`, `assigneeRoleKey`, `timeoutHours`, `escalateToRoleKey`, `customerVisible` | tenant | unique: `versionId + key`; cross-tenant guard on `versionId` |

### 3.6 Service requests (cases)

A case from draft to completion, with its form answers, checklist, history and workflow execution.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `service_requests` | The case: customer, service (with a frozen `serviceSnapshot`), status, payment status, assignee and reviewer, pinned form and workflow version, mirrored external status, tracking-code hash. | `branchId`, `requestNo`, `customerId`, `corporateAccountId`, `serviceId`, `serviceSnapshot`, `status` (RequestStatus), `priority` (RequestPriority), `source` (RequestSource), `paymentStatus` (RequestPaymentStatus), `assignedToId`, `reviewerId`, `customerInstructions`, `submittedAt`, `targetDate`, `completedAt`, `cancelledAt`, `cancellationReason`, `submissionChannel` (SubmissionChannel), `externalStatus`, `externalStatusSource` (StatusSource), `externalStatusAt`, `formDefinitionId`, `workflowVersionId`, `duplicateOfId`, `renewalOfDocumentId`, `reopenedCount`, `trackingCodeHash`, `createdById`, `createdByType` (ActorType), `deletedAt`, `version` | tenant | unique: `tenantId + requestNo`; cross-tenant guard on `branchId`, `customerId`, `corporateAccountId`, `serviceId`, `assignedToId`, `reviewerId`, `duplicateOfId` |
| `request_fields` | Form answers of a request, one row per field key. | `requestId`, `key`, `value`, `source`, `verified` | tenant | unique: `requestId + key`; cross-tenant guard on `requestId` |
| `request_documents` | Checklist lines (input and completion documents) with the linked document and review state. | `requestId`, `requirementId`, `documentTypeKey`, `label`, `labelAr`, `kind`, `isMandatory`, `documentId`, `status` (ChecklistStatus), `rejectionReason`, `reviewedById`, `reviewedAt`, `sortOrder` | tenant | cross-tenant guard on `requestId`, `documentId`; check: `request_documents_kind` |
| `request_status_history` | Every status change with actor, reason and the customer-visible wording. | `requestId`, `fromStatus` (RequestStatus), `toStatus` (RequestStatus), `actorId`, `actorType` (ActorType), `reason`, `customerVisible`, `customerMessage`, `meta` | tenant | cross-tenant guard on `requestId`; append-only (trigger: no UPDATE / DELETE); `typease_app`: SELECT, INSERT |
| `request_assignments` | Assignment history (operator / reviewer); one active row per role. | `requestId`, `assigneeId`, `role`, `method`, `reason`, `assignedById`, `assignedAt`, `unassignedAt` | tenant | partial unique index `request_assignments_one_active` (WHERE unassignedAt IS NULL); cross-tenant guard on `requestId`, `assigneeId` |
| `request_approvals` | Internal review decisions. | `requestId`, `type`, `status` (ApprovalStatus), `stepKey`, `requestedById`, `decidedById`, `decidedAt`, `comment`, `payload` | tenant | cross-tenant guard on `requestId` |
| `request_comments` | Comments on a request, internal or customer-visible. | `requestId`, `authorId`, `authorType` (ActorType), `authorName`, `body`, `visibility` (Visibility) | tenant | cross-tenant guard on `requestId` |
| `request_external_references` | Submissions recorded by staff: channel, authority or partner, reference number, status and the source of that status. | `requestId`, `channel` (SubmissionChannel), `authorityName`, `referenceNo`, `partnerName`, `partnerReference`, `status`, `statusSource` (StatusSource), `integrationId`, `notes`, `recordedById`, `recordedAt` | tenant | cross-tenant guard on `requestId` |
| `workflow_executions` | The running workflow of a request (one per request) and its current step. | `requestId`, `versionId`, `status` (ExecutionStatus), `currentStepKey`, `migratedFromVersionId`, `startedAt`, `completedAt` | tenant | unique: `requestId`; cross-tenant guard on `requestId`, `versionId` |
| `workflow_step_executions` | Execution history of steps, one row per attempt. | `executionId`, `stepKey`, `stepName`, `stepType` (WorkflowStepType), `status` (StepStatus), `attempt`, `startedAt`, `completedAt`, `dueAt`, `escalatedAt`, `actorId`, `result` | tenant | cross-tenant guard on `executionId` |

### 3.7 Documents and AI assistance

The document vault. File bytes live in object storage; these tables hold metadata and keys.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `documents` | A document of a customer, company or request: type, status, verification, expiry, visibility, legal hold, retention and soft-delete fields. | `customerId`, `corporateAccountId`, `requestId`, `documentTypeKey`, `category`, `title`, `currentVersionId`, `status` (DocumentStatus), `verificationStatus` (VerificationStatus), `verifiedById`, `verifiedAt`, `issuedDate`, `expiryDate`, `expiryVerified`, `isCompletionDocument`, `customerVisible`, `legalHold`, `retentionUntil`, `uploadedById`, `uploadedByType` (ActorType), `deletedAt`, `deletedById`, `purgeAfter` | tenant | cross-tenant guard on `customerId`, `corporateAccountId`, `requestId` |
| `document_versions` | Stored files: storage key, declared and detected type, size, SHA-256, encryption, upload and malware-scan state. | `documentId`, `versionNo`, `storageKey`, `originalFilename`, `declaredMime`, `detectedMime`, `sizeBytes`, `sha256`, `encryption`, `encryptionMeta`, `uploadStatus`, `uploadExpiresAt`, `scanStatus` (ScanStatus), `scanEngine`, `scanDetail`, `scannedAt`, `uploadedById` | tenant | unique: `storageKey`; `documentId + versionNo`; cross-tenant guard on `documentId`; check: `document_versions_size` |
| `document_access_logs` | Who viewed, linked, downloaded, shared, changed or deleted a document, including support access. | `documentId`, `versionId`, `actorId`, `actorType` (ActorType), `action`, `supportGrantId`, `ip`, `userAgent` | tenant | append-only (trigger: no UPDATE / DELETE); `typease_app`: SELECT, INSERT |
| `document_shares` | Time- and count-limited share links (token hash only). | `documentId`, `tokenHash`, `recipient`, `expiresAt`, `maxDownloads`, `downloadCount`, `revokedAt`, `createdById` | tenant | unique: `tokenHash`; cross-tenant guard on `documentId`; check: `document_shares_limits` |
| `document_verification_results` | Verification decisions of reviewers. | `documentId`, `versionId`, `reviewerId`, `decision`, `reason`, `fieldsConfirmed` | tenant | cross-tenant guard on `documentId` |
| `ocr_extraction_results` | OCR suggestions and the reviewer's decisions per field. Identity numbers inside are encrypted. | `documentId`, `versionId`, `provider`, `profile`, `status` (OcrStatus), `classification`, `classificationConfidence`, `fields`, `warnings`, `pages`, `costUnits`, `error`, `requestedById`, `reviewedById`, `reviewedAt`, `reviewedFields`, `completedAt` | tenant | cross-tenant guard on `documentId` |
| `ai_usage_logs` | Pages processed and estimated cost per OCR run. | `provider`, `operation`, `documentId`, `pages`, `units`, `costEstimate`, `currency`, `actorId`, `success` | tenant | `typease_app`: SELECT, INSERT |

### 3.8 Customer finance

Money between a centre and its customers.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `fee_components` | Accounting treatment of the three fee components per centre (service fee is always revenue). | `type` (FeeComponentType), `name`, `treatment` (AccountingTreatment), `taxable`, `ledgerCode`, `reviewNote` | tenant | unique: `tenantId + type`; check: `fee_components_service_fee_is_revenue` |
| `quotations` | Quotations with totals per component, validity and discount approval. | `branchId`, `quotationNo`, `requestId`, `customerId`, `corporateAccountId`, `status` (QuotationStatus), `currency`, `subtotalServiceFee`, `subtotalGovernmentFee`, `subtotalThirdParty`, `discountTotal`, `taxTotal`, `total`, `validUntil`, `notes`, `discountApproval`, `discountRequestedById`, `discountDecidedById`, `discountReason`, `sentAt`, `decidedAt`, `decidedById`, `decidedByType` (ActorType), `rejectionReason`, `createdById`, `version` | tenant | unique: `tenantId + quotationNo`; cross-tenant guard on `branchId`, `requestId`, `customerId`, `corporateAccountId`; check: `quotations_totals`, `quotations_discount_approval` |
| `quotation_items` | Quotation lines. | `quotationId`, `serviceId`, `description`, `component` (FeeComponentType), `quantity`, `unitAmount`, `discountAmount`, `taxRatePercent`, `taxAmount`, `lineTotal`, `sortOrder` | tenant | cross-tenant guard on `quotationId`; check: `quotation_items_amounts`; lines frozen once the parent leaves DRAFT (trigger) |
| `invoices` | Invoices with totals, paid / credited / refunded amounts and the derived balance. | `branchId`, `invoiceNo`, `requestId`, `quotationId`, `customerId`, `corporateAccountId`, `status` (InvoiceStatus), `currency`, `subtotalServiceFee`, `subtotalGovernmentFee`, `subtotalThirdParty`, `discountTotal`, `taxTotal`, `total`, `amountPaid`, `amountCredited`, `amountRefunded`, `balanceDue`, `issuedAt`, `dueAt`, `voidedAt`, `voidReason`, `notes`, `createdById`, `version` | tenant | unique: `tenantId + invoiceNo`; cross-tenant guard on `branchId`, `requestId`, `quotationId`, `customerId`, `corporateAccountId`; check: `invoices_totals`, `invoices_balance`; immutable once issued (trigger); `typease_app`: SELECT, INSERT, UPDATE |
| `invoice_items` | Invoice lines. | `invoiceId`, `serviceId`, `description`, `component` (FeeComponentType), `quantity`, `unitAmount`, `discountAmount`, `taxRatePercent`, `taxAmount`, `lineTotal`, `sortOrder` | tenant | cross-tenant guard on `invoiceId`; check: `invoice_items_amounts`; lines frozen once the parent leaves DRAFT (trigger) |
| `payments` | Payments by cash, card terminal, bank transfer, cheque or online gateway; receipt number; reconciliation link. | `branchId`, `paymentNo`, `receiptNo`, `customerId`, `corporateAccountId`, `method` (PaymentMethod), `status` (PaymentStatus), `amount`, `refundedAmount`, `currency`, `gateway`, `gatewaySessionRef`, `gatewayPaymentRef`, `reference`, `idempotencyKey`, `failureReason`, `notes`, `receivedById`, `receivedAt`, `reconciliationId`, `reconciledAt` | tenant | unique: `tenantId + paymentNo`; `tenantId + idempotencyKey`; `gateway + gatewayPaymentRef`; cross-tenant guard on `branchId`, `customerId`, `reconciliationId`; check: `payments_amounts`, `payments_gateway_fields`; immutable once completed, never deleted (trigger); `typease_app`: SELECT, INSERT, UPDATE |
| `payment_allocations` | Which part of a payment settles which invoice. | `paymentId`, `invoiceId`, `amount` | tenant | cross-tenant guard on `paymentId`, `invoiceId`; check: `payment_allocations_positive`; append-only (trigger: no UPDATE / DELETE); allocations cannot exceed the payment (trigger); `typease_app`: SELECT, INSERT |
| `refunds` | Refund requests and their decision, split by component (`breakdown`). | `refundNo`, `paymentId`, `invoiceId`, `requestId`, `amount`, `currency`, `breakdown`, `reason`, `status` (RefundStatus), `method`, `requestedById`, `decidedById`, `decidedAt`, `rejectionReason`, `processedAt`, `gatewayRefundRef` | tenant | unique: `tenantId + refundNo`; cross-tenant guard on `paymentId`, `invoiceId`; check: `refunds_positive`; amount and currency immutable, never deleted (trigger); `typease_app`: SELECT, INSERT, UPDATE |
| `credit_notes` | Credit notes against issued invoices. | `creditNoteNo`, `invoiceId`, `amount`, `taxAmount`, `currency`, `breakdown`, `reason`, `status`, `issuedById`, `issuedAt` | tenant | unique: `tenantId + creditNoteNo`; cross-tenant guard on `invoiceId`; check: `credit_notes_positive`; amount and currency immutable, never deleted (trigger); `typease_app`: SELECT, INSERT, UPDATE |
| `expenses` | Expenses, including remittances of government and third-party fees. | `branchId`, `category`, `requestId`, `description`, `amount`, `currency`, `paidOn`, `payee`, `reference`, `method`, `recordedById`, `deletedAt` | tenant | cross-tenant guard on `branchId`; check: `expenses_positive` |
| `liability_entries` | Ledger of money held for authorities and third parties: accrual, reversal, remittance. | `branchId`, `component` (FeeComponentType), `direction`, `amount`, `currency`, `requestId`, `invoiceId`, `sourceType`, `sourceId`, `occurredAt` | tenant | check: `liability_entries_valid`; append-only (trigger: no UPDATE / DELETE); `typease_app`: SELECT, INSERT |
| `reconciliation_records` | Reconciliation of payments against a statement or settlement. | `branchId`, `method` (PaymentMethod), `gateway`, `periodStart`, `periodEnd`, `statementReference`, `expectedAmount`, `settledAmount`, `feeAmount`, `difference`, `status`, `notes`, `reconciledById` | tenant | - |
| `payment_webhook_events` | Verified gateway webhook events, for duplicate protection (customer payments and subscription payments, by namespace). | `gateway`, `eventId`, `eventType`, `signatureValid`, `payloadHash`, `status`, `error`, `receivedAt`, `processedAt` | system-only | unique: `gateway + eventId`; no grant to `typease_app` |
| `idempotency_keys` | Stored responses for `Idempotency-Key` on payments and refunds (24 hours). | `scope`, `key`, `requestHash`, `responseStatus`, `responseBody`, `expiresAt` | tenant | unique: `tenantId + scope + key` |
| `document_templates` | Ready-made document templates of a centre (migration 0010): salary certificate, NOC, employment contract, experience letter (built-ins provisioned) and the centre's own. | `key`, `kind`, `name`, `nameAr`, `titleEn`, `titleAr`, `bodyEn`, `bodyAr`, `fields`, `requiresSignature`, `isBuiltIn`, `isActive`, `version` | tenant | unique: `tenantId + key`; check: `document_templates_kind` |
| `generated_documents` | Documents generated for customers from templates: text frozen at issue (`contentHash`), electronic signature (link or counter), hand-over. | `documentNo`, `templateId`, `templateVersion`, `customerId`, `requestId`, `branchId`, `titleEn`, `titleAr`, `bodyEn`, `bodyAr`, `values`, `status` (GeneratedDocumentStatus), `requiresSignature`, `contentHash`, `issuedAt`, `signerName`, `signatureImage`, `signedAt`, `signedVia`, `signedIp`, `handedOverAt`, `handedOverById`, `handedOverTo`, `handoverNote`, `voidedAt`, `voidReason`, `createdById` | tenant | unique: `tenantId + documentNo`; check: `generated_documents_signed`, `generated_documents_handed_over`, `generated_documents_signature_size`; text final after DRAFT, signature final, only drafts deleted, erasure redaction as the one exception (trigger `generated_document_immutability`); cross-tenant guard on `templateId`, `customerId`, `requestId`, `branchId` |
| `wa_conversations` | WhatsApp team inbox (migration 0011): one conversation per phone number of a centre, linked to the customer, with assignment, status, unread count and the 24-hour reply window (`lastInboundAt`). | `phone`, `contactName`, `customerId`, `branchId`, `status`, `assignedToId`, `unreadCount`, `lastMessageAt`, `lastInboundAt`, `lastPreview` | tenant | unique: `tenantId + phone`; check: `wa_conversations_status`, `wa_conversations_phone`; cross-tenant guard on `customerId`, `branchId`, `assignedToId` |
| `wa_messages` | Inbound, outbound and internal-note messages of a conversation; inbound media is stored in the document vault (`documentId`). | `conversationId`, `direction`, `kind`, `body`, `mediaProviderId`, `mediaMime`, `mediaName`, `documentId`, `providerMessageId`, `status`, `error`, `authorId` | tenant | unique: `tenantId + providerMessageId` (`wa_messages_provider_once`, webhook retries stored once); check: `wa_messages_direction`, `wa_messages_kind`, `wa_messages_status`; cross-tenant guard on `conversationId`, `documentId` |
| `staff_pay` | Pay set-up of a staff member (migration 0012): salary, allowances, pay method, WPS person code, bank routing code; the IBAN encrypted (`ibanEnc`, `ibanLast4`). | `membershipId`, `basicSalary`, `housingAllowance`, `transportAllowance`, `otherAllowance`, `payMethod`, `employeeWpsId`, `bankRoutingCode`, `ibanEnc`, `ibanLast4`, `includeCommission`, `isActive` | tenant | unique: `tenantId + membershipId`; check: `staff_pay_amounts`, `staff_pay_method`; cross-tenant guard on `membershipId` |
| `payroll_runs` | Monthly payroll: draft, approved, paid (posted to the ledger as `PAYROLL`). | `runNo`, `period`, `status` (PayrollRunStatus), `currency`, `totalGross`, `totalDeductions`, `totalNet`, `notes`, `createdById`, `approvedById`, `approvedAt`, `paidById`, `paidAt`, `paymentReference` | tenant | unique: `tenantId + runNo`; `tenantId + period`; check: `payroll_runs_period`; final once paid (trigger `payroll_paid_immutability`) |
| `payroll_lines` | One staff member's pay in a run, with the commission entries it pays out. | `runId`, `membershipId`, `staffName`, `jobTitle`, `payMethod`, `daysWorked`, `daysInPeriod`, `basicSalary`, `allowances`, `overtime`, `commission`, `deductions`, `deductionNote`, `gross`, `net`, `commissionEntryIds` | tenant | unique: `runId + membershipId`; check: `payroll_lines_amounts`; changed only while the run is a draft (trigger); cross-tenant guard on `runId`, `membershipId` |
| `leads` | CRM leads (migration 0012): enquiries with owner, follow-up and outcome; won leads link the customer and first request. | `leadNo`, `name`, `phone`, `email`, `source`, `serviceId`, `interest`, `estimatedValue`, `status` (LeadStatus), `lostReason`, `ownerId`, `nextFollowUpAt`, `customerId`, `requestId`, `conversationId`, `createdById`, `wonAt` | tenant | unique: `tenantId + leadNo`; check: `leads_source`, `leads_lost_reason`, `leads_contact`; cross-tenant guard on `serviceId`, `ownerId`, `customerId`, `requestId`, `conversationId` |
| `lead_activities` | Calls, messages, visits, notes and status changes of a lead. | `leadId`, `kind`, `body`, `createdById` | tenant | check: `lead_activities_kind`; cross-tenant guard on `leadId` |
| `cashier_shifts` | Till sessions: opening float, counted cash by denomination, expected cash and variance, manager review (migration 0005). Payments, refunds and expenses carry `shiftId`. | `branchId`, `shiftNo`, `currency`, `status` (CashierShiftStatus), `openedById`, `openedByName`, `openedAt`, `openingFloat`, `openingNote`, `closedById`, `closedAt`, `expected`, `countedCash`, `countedCard`, `cashVariance`, `cardVariance`, `denominations`, `closingNote`, `reviewedById`, `reviewedAt`, `reviewNote`, `version` | tenant | unique: `tenantId + shiftNo`; one OPEN shift per person (`cashier_shifts_one_open_per_person`); check: `cashier_shifts_float_check`, `cashier_shifts_counts_check`, `cashier_shifts_closed_check`; cross-tenant guard on `branchId` |
| `invoice_reminders` | Payment reminders sent for an invoice, automatic (by stage, days from the due date) or by staff (migration 0006). `invoices.remindersPausedUntil` pauses them. | `invoiceId`, `stage`, `daysOverdue`, `automatic`, `amount`, `currency`, `sentById` | tenant | unique: one automatic reminder per `invoiceId + stage` (`invoice_reminders_auto_stage_once`); check: `invoice_reminders_stage_check`; cross-tenant guard on `invoiceId` |
| `commission_rules` | Staff commission per service (or the default for all services) and beneficiary: percentage of the service fee or a fixed amount (migration 0007). | `serviceId`, `beneficiary` (CommissionBeneficiary), `kind` (CommissionKind), `value`, `isActive`, `createdById` | tenant | one active rule per `serviceId + beneficiary` (`commission_rules_one_active`); check: `commission_rules_value_check`; cross-tenant guard on `serviceId` |
| `commission_entries` | Commission earned on a completed request; voided when the request is reopened, paid out with a reference. | `ruleId`, `requestId`, `serviceId`, `membershipId`, `userId`, `beneficiary` (CommissionBeneficiary), `basis`, `kind` (CommissionKind), `value`, `amount`, `currency`, `status` (CommissionEntryStatus), `earnedAt`, `paidAt`, `paidById`, `payoutRef`, `voidedAt`, `voidReason` | tenant | unique: `requestId + ruleId + membershipId` while not VOID (`commission_entries_once`); check: `commission_entries_amount_check`; final once PAID (trigger `commission_paid_immutability`) |
| `ledger_accounts` | Chart of accounts per centre (migration 0008). System accounts (`systemKey`) are used by the automatic postings. | `code`, `name`, `nameAr`, `type` (LedgerAccountType), `systemKey`, `isActive` | tenant | unique: `tenantId + code`; `tenantId + systemKey` |
| `journal_entries` | Double-entry journals: automatic (one per source document and kind) or manual; reversals link to the original. | `entryNo`, `date`, `memo`, `sourceType`, `sourceId`, `branchId`, `reversalOfId`, `createdById` | tenant | unique: `tenantId + entryNo`; automatic source posted once (`journal_entries_source_once`); reversed once; never changed or deleted (trigger); `typease_app`: SELECT, INSERT |
| `journal_lines` | Debit or credit lines of a journal. | `entryId`, `accountId`, `debit`, `credit`, `memo`, `customerId` | tenant | check: `journal_lines_one_side`; every journal balanced at commit (deferred trigger `journal_balanced`); cross-tenant guard on `entryId`, `accountId`; never changed or deleted (trigger); `typease_app`: SELECT, INSERT |

### 3.9 Appointments, queue and tasks

Day-to-day operations of a branch.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `appointment_slot_configs` | Weekly slot calendar per branch (and optionally per service) with capacity. | `branchId`, `serviceId`, `weekday`, `startTime`, `endTime`, `slotMinutes`, `capacity`, `isActive` | tenant | cross-tenant guard on `branchId`; check: `slot_configs_valid` |
| `branch_closures` | Days a branch is closed. | `branchId`, `date`, `reason` | tenant | unique: `branchId + date`; cross-tenant guard on `branchId` |
| `appointments` | Bookings by customers, guests and staff. | `branchId`, `customerId`, `guestName`, `guestPhone`, `serviceId`, `requestId`, `staffId`, `startsAt`, `endsAt`, `status` (AppointmentStatus), `source`, `notes`, `cancelledReason`, `rescheduledFromId`, `checkedInAt`, `reminderSentAt`, `createdById` | tenant | cross-tenant guard on `branchId`, `customerId`, `serviceId`, `staffId`, `rescheduledFromId`; check: `appointments_time_order`, `appointments_has_person` |
| `queue_tokens` | Walk-in queue tokens per branch and day. | `branchId`, `queueDate`, `tokenNo`, `categoryId`, `customerId`, `appointmentId`, `status` (QueueStatus), `counter`, `servedById`, `issuedAt`, `calledAt`, `servedAt`, `completedAt` | tenant | unique: `branchId + queueDate + tokenNo`; cross-tenant guard on `branchId`, `customerId` |
| `tasks` | Tasks: manual, workflow, automation and escalation. | `branchId`, `requestId`, `customerId`, `title`, `description`, `type`, `priority` (RequestPriority), `status` (TaskStatus), `source`, `stepKey`, `roleKey`, `dueAt`, `completedAt`, `completedById`, `createdById` | tenant | cross-tenant guard on `requestId` |
| `task_assignments` | Assignment history of tasks. | `taskId`, `assigneeId`, `assignedById`, `assignedAt`, `unassignedAt` | tenant | cross-tenant guard on `taskId`, `assigneeId` |

### 3.10 Notifications and reminders

Outgoing messages and document-expiry reminders.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `notification_templates` | Message templates: platform defaults (no tenant) and centre overrides, per event, channel and language. | `eventKey`, `channel` (NotificationChannel), `language`, `name`, `subject`, `body`, `whatsappTemplateName`, `isActive`, `updatedById` | shared-readable | unique: `tenantId + eventKey + channel + language`; the unique key treats NULL as a value (`NULLS NOT DISTINCT`) |
| `notifications` | Every notification created, sent, failed or suppressed, with the reason. | `recipientUserId`, `recipientCustomerId`, `recipientAddress`, `eventKey`, `channel` (NotificationChannel), `language`, `subject`, `body`, `data`, `status` (NotificationStatus), `suppressedReason`, `relatedType`, `relatedId`, `dedupeKey`, `readAt`, `sentAt` | tenant | unique: `tenantId + dedupeKey` |
| `notification_deliveries` | One row per delivery attempt with provider and error. | `notificationId`, `provider`, `attempt`, `status` (DeliveryStatus), `providerMessageId`, `error`, `requestedAt`, `completedAt` | tenant | cross-tenant guard on `notificationId` |
| `notification_preferences` | Explicit opt-in / opt-out per channel and event group, for a user or a customer. | `userId`, `customerId`, `channel` (NotificationChannel), `eventGroup`, `enabled` | tenant | unique: `tenantId + userId + customerId + channel + eventGroup`; the unique key treats NULL as a value (`NULLS NOT DISTINCT`) |
| `device_tokens` | Push tokens of signed-in devices. | `userId`, `platform`, `token`, `lastSeenAt` | tenant | unique: `tenantId + token` |
| `reminder_schedules` | Expiry reminder schedules per customer or company and document type. | `customerId`, `corporateAccountId`, `documentId`, `documentTypeKey`, `subjectLabel`, `expiryDate`, `offsetsDays`, `status` (ReminderStatus), `renewalRequestId`, `createdById` | tenant | cross-tenant guard on `customerId`, `documentId` |
| `reminder_dispatches` | What happened to each reminder offset (sent, skipped for consent, failed ...). | `scheduleId`, `offsetDays`, `dueOn`, `status`, `notificationId`, `detail`, `processedAt` | tenant | unique: `scheduleId + offsetDays`; cross-tenant guard on `scheduleId` |

### 3.11 Support

Tickets between customers and the centre, and between a centre and TypEase.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `sla_policies` | Response and resolution targets per priority. | `name`, `priority` (RequestPriority), `firstResponseMinutes`, `resolutionMinutes`, `isActive` | tenant | unique: `tenantId + priority` |
| `support_tickets` | Tickets of scope `CUSTOMER` (customer to centre) or `PLATFORM` (centre to TypEase). | `ticketNo`, `scope`, `customerId`, `requestId`, `raisedByUserId`, `subject`, `category`, `priority` (RequestPriority), `status` (TicketStatus), `assigneeId`, `platformAssigneeId`, `firstResponseDueAt`, `resolutionDueAt`, `firstRespondedAt`, `resolvedAt`, `closedAt`, `resolutionSummary` | tenant | unique: `tenantId + ticketNo`; cross-tenant guard on `customerId`, `requestId` |
| `support_messages` | Messages and internal notes of a ticket. | `ticketId`, `authorUserId`, `authorType` (ActorType), `authorName`, `body`, `visibility` (Visibility), `attachments` | tenant | cross-tenant guard on `ticketId` |
| `customer_feedback` | Ratings 1-5 after completed requests and resolved tickets. | `customerId`, `requestId`, `ticketId`, `rating`, `comment` | tenant | cross-tenant guard on `customerId`; check: `customer_feedback_rating` |

### 3.12 Events, automation and reports

The transactional outbox and what reacts to it.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `outbox_events` | Domain events written in the transaction of the change and delivered by the worker. | `type`, `payload`, `status` (OutboxStatus), `attempts`, `availableAt`, `processedAt`, `error` | tenant (platform rows have no tenant and are invisible to centres) | `typease_app`: SELECT, INSERT |
| `automation_rules` | Automation rules: trigger, conditions, actions. | `name`, `description`, `templateKey`, `triggerEvent`, `conditions`, `actions`, `isEnabled`, `maxRetries`, `createdById` | tenant | - |
| `automation_executions` | One row per rule and event with the result of every action. | `ruleId`, `eventId`, `eventType`, `status` (AutomationExecutionStatus), `attempts`, `actionResults`, `error`, `startedAt`, `finishedAt` | tenant | unique: `ruleId + eventId`; cross-tenant guard on `ruleId` |
| `scheduled_reports` | Report schedules with recipients and the next run time. | `reportKey`, `params`, `format`, `frequency`, `recipients`, `isActive`, `nextRunAt`, `lastRunAt`, `lastStatus`, `createdById` | tenant | - |

### 3.13 Audit, privacy and integrations

The record of who did what, privacy administration, and external service configuration.

| Table | Purpose | Columns (besides `id`, `tenantId`, `createdAt`, `updatedAt`) | Scope | Rules enforced by the database |
| --- | --- | --- | --- | --- |
| `audit_logs` | The audit trail of a centre (and, without a tenant, of the platform). | `actorUserId`, `actorType` (ActorType), `actorLabel`, `action`, `resourceType`, `resourceId`, `summary`, `before`, `after`, `supportGrantId`, `requestId`, `ip`, `userAgent` | tenant (platform rows have no tenant and are invisible to centres) | append-only (trigger: no UPDATE / DELETE); `typease_app`: SELECT, INSERT |
| `security_events` | Security-relevant events: failed sign-ins, permission denials, token reuse, webhook failures, support access, malware. | `userId`, `type`, `severity`, `details`, `ip` | tenant (platform rows have no tenant and are invisible to centres) | append-only (trigger: no UPDATE / DELETE); `typease_app`: SELECT, INSERT |
| `access_grants` | Time-limited support access requested by TypEase staff and decided by the centre. | `requestedById`, `reason`, `scopes`, `ticketId`, `status` (AccessGrantStatus), `durationMinutes`, `decidedById`, `decidedAt`, `decisionNote`, `startsAt`, `expiresAt`, `revokedAt` | tenant | check: `access_grants_duration`; `typease_app`: SELECT, UPDATE |
| `consent_records` | History of every consent decision. | `customerId`, `userId`, `purpose`, `status` (ConsentStatus), `lawfulBasis`, `noticeVersion`, `capturedVia`, `capturedById`, `ip` | tenant | append-only (trigger: no UPDATE / DELETE); `typease_app`: SELECT, INSERT |
| `data_retention_policies` | Retention periods per entity and document type. | `entity`, `documentTypeKey`, `retainDays`, `action`, `legalBasisNote`, `isActive`, `updatedById` | tenant | unique: `tenantId + entity + documentTypeKey`; the unique key treats NULL as a value (`NULLS NOT DISTINCT`) |
| `data_subject_requests` | Access, correction, deletion and export requests of customers. | `customerId`, `requestedByUserId`, `type` (DataRequestType), `status` (DataRequestStatus), `details`, `decisionNote`, `retentionException`, `handledById`, `exportDocumentId`, `dueAt`, `completedAt` | tenant | cross-tenant guard on `customerId` |
| `security_incidents` | Incident register of a centre and of the platform. | `title`, `description`, `severity`, `status`, `affectedData`, `personalDataInvolved`, `notificationRequired`, `authorityNotifiedAt`, `individualsNotifiedAt`, `resolutionNotes`, `detectedAt`, `resolvedAt`, `reportedById` | system-only | no grant to `typease_app` |
| `processor_records` | Vendor / processor register with cross-border review. | `name`, `purpose`, `dataCategories`, `country`, `crossBorder`, `safeguards`, `status`, `reviewedById`, `reviewedAt` | system-only | no grant to `typease_app` |
| `integration_credentials_metadata` | Configured integrations of a centre: settings in `config`, credentials only as one encrypted envelope in `secretsEnc`. | `category`, `provider`, `name`, `status` (IntegrationStatus), `mode`, `config`, `secretsEnc`, `secretKeys`, `secretsUpdatedAt`, `authorisationNote`, `authorisationVerifiedById`, `authorisationVerifiedAt`, `lastTestedAt`, `lastTestOk`, `lastTestMessage`, `createdById` | tenant (platform rows have no tenant and are invisible to centres) | unique: `tenantId + category + provider`; the unique key treats NULL as a value (`NULLS NOT DISTINCT`) |
| `integration_logs` | Redacted log of connection tests and integration calls. | `integrationId`, `category`, `provider`, `operation`, `direction`, `success`, `statusCode`, `durationMs`, `request`, `response`, `error`, `relatedType`, `relatedId` | tenant | `typease_app`: SELECT, INSERT |

## 4. Enums

| Enum | Values | Used by |
| --- | --- | --- |
| `PlatformRole` | `SUPER_ADMIN`, `SUPPORT_AGENT` | `users.platformRole` |
| `UserStatus` | `ACTIVE`, `DISABLED` | `users.status` |
| `TenantStatus` | `ONBOARDING`, `PENDING_APPROVAL`, `TRIAL`, `ACTIVE`, `PAST_DUE`, `SUSPENDED`, `CANCELLED`, `ARCHIVED` | `tenants.status` |
| `MembershipKind` | `STAFF`, `CUSTOMER`, `CORPORATE` | `roles.kind`, `tenant_memberships.kind` |
| `MembershipStatus` | `INVITED`, `ACTIVE`, `SUSPENDED`, `REMOVED` | `tenant_memberships.status` |
| `SubscriptionStatus` | `TRIALING`, `ACTIVE`, `PAST_DUE`, `GRACE`, `CANCELLED`, `EXPIRED` | `subscriptions.status` |
| `BillingCycle` | `MONTHLY`, `ANNUAL` | `subscriptions.billingCycle`, `subscriptions.pendingCycle` |
| `SubscriptionInvoiceStatus` | `DRAFT`, `OPEN`, `PAID`, `VOID`, `UNCOLLECTIBLE` | `subscription_invoices.status` |
| `DomainStatus` | `PENDING`, `VERIFIED`, `FAILED`, `DISABLED` | `tenant_domains.status` |
| `CustomerType` | `INDIVIDUAL`, `BUSINESS` | `customers.type` |
| `CustomerStatus` | `ACTIVE`, `ARCHIVED`, `MERGED`, `ANONYMISED` | `customers.status` |
| `ConsentStatus` | `GRANTED`, `WITHDRAWN` | `customer_consents.status`, `consent_records.status` |
| `CorporateStatus` | `PENDING_VERIFICATION`, `ACTIVE`, `SUSPENDED`, `ARCHIVED` | `corporate_accounts.status` |
| `ComplianceCapability` | `DOCUMENT_PREPARATION_ONLY`, `PARTNER_COORDINATION`, `DIRECT_AUTHORISED`, `INFORMATIONAL_ONLY` | `services.complianceCapability` |
| `PublishStatus` | `DRAFT`, `PUBLISHED`, `ARCHIVED` | `service_form_definitions.status`, `workflow_versions.status` |
| `WorkflowStepType` | `CUSTOMER_FORM`, `DOCUMENT_UPLOAD`, `STAFF_VERIFICATION`, `INTERNAL_APPROVAL`, `CUSTOMER_APPROVAL`, `QUOTATION`, `PAYMENT`, `STAFF_TASK`, `EXTERNAL_PROCESSING`, `NOTIFICATION`, `DOCUMENT_GENERATION`, `COMPLETION`, `CONDITIONAL_BRANCH` | `workflow_steps.type`, `workflow_step_executions.stepType` |
| `RequestStatus` | `DRAFT`, `SUBMITTED`, `AWAITING_CUSTOMER`, `UNDER_REVIEW`, `QUOTED`, `AWAITING_PAYMENT`, `READY_FOR_PROCESSING`, `IN_PREPARATION`, `PENDING_APPROVAL`, `READY_TO_SUBMIT`, `EXTERNAL_PROCESSING`, `RETURNED`, `REJECTED`, `FINAL_REVIEW`, `COMPLETED`, `CANCELLED` | `service_requests.status`, `request_status_history.fromStatus`, `request_status_history.toStatus` |
| `RequestPriority` | `LOW`, `NORMAL`, `HIGH`, `URGENT` | `service_requests.priority`, `tasks.priority`, `sla_policies.priority`, `support_tickets.priority` |
| `RequestSource` | `WALK_IN`, `ONLINE`, `MOBILE`, `CORPORATE` | `service_requests.source` |
| `RequestPaymentStatus` | `NOT_REQUIRED`, `UNPAID`, `PARTIALLY_PAID`, `PAID`, `PARTIALLY_REFUNDED`, `REFUNDED` | `service_requests.paymentStatus` |
| `CashierShiftStatus` | `OPEN`, `CLOSED`, `REVIEWED` | `cashier_shifts.status` |
| `CommissionBeneficiary` | `OPERATOR`, `REVIEWER`, `CREATOR` | `commission_rules.beneficiary`, `commission_entries.beneficiary` |
| `CommissionKind` | `PERCENT`, `FIXED` | `commission_rules.kind`, `commission_entries.kind` |
| `CommissionEntryStatus` | `ACCRUED`, `PAID`, `VOID` | `commission_entries.status` |
| `LedgerAccountType` | `ASSET`, `LIABILITY`, `EQUITY`, `REVENUE`, `EXPENSE` | `ledger_accounts.type` |
| `GeneratedDocumentStatus` | `DRAFT`, `ISSUED`, `SIGNED`, `HANDED_OVER`, `VOID` | `generated_documents.status` |
| `PayrollRunStatus` | `DRAFT`, `APPROVED`, `PAID` | `payroll_runs.status` |
| `LeadStatus` | `NEW`, `CONTACTED`, `QUOTED`, `WON`, `LOST` | `leads.status` |
| `SubmissionChannel` | `MANUAL_PORTAL`, `AUTHORISED_PARTNER`, `OFFICIAL_API` | `service_requests.submissionChannel`, `request_external_references.channel` |
| `StatusSource` | `INTERNAL`, `STAFF_ENTERED`, `PARTNER_PROVIDED`, `VERIFIED_OFFICIAL` | `service_requests.externalStatusSource`, `request_external_references.statusSource` |
| `ChecklistStatus` | `MISSING`, `UPLOADED`, `VERIFIED`, `REJECTED`, `WAIVED` | `request_documents.status` |
| `ApprovalStatus` | `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED` | `request_approvals.status` |
| `ExecutionStatus` | `ACTIVE`, `COMPLETED`, `CANCELLED`, `FAILED` | `workflow_executions.status` |
| `StepStatus` | `PENDING`, `ACTIVE`, `COMPLETED`, `SKIPPED`, `FAILED`, `TIMED_OUT`, `CANCELLED` | `workflow_step_executions.status` |
| `ActorType` | `STAFF`, `CUSTOMER`, `CORPORATE`, `PLATFORM`, `SYSTEM`, `AUTOMATION` | `service_requests.createdByType`, `request_status_history.actorType`, `request_comments.authorType`, `documents.uploadedByType`, `document_access_logs.actorType`, `quotations.decidedByType`, `support_messages.authorType`, `audit_logs.actorType` |
| `DocumentStatus` | `PENDING_UPLOAD`, `PENDING_SCAN`, `AVAILABLE`, `QUARANTINED`, `DELETED` | `documents.status` |
| `VerificationStatus` | `UNVERIFIED`, `VERIFIED`, `REJECTED` | `documents.verificationStatus` |
| `ScanStatus` | `PENDING`, `CLEAN`, `INFECTED`, `ERROR`, `SKIPPED` | `document_versions.scanStatus` |
| `OcrStatus` | `QUEUED`, `PROCESSING`, `COMPLETED`, `FAILED`, `REVIEWED` | `ocr_extraction_results.status` |
| `QuotationStatus` | `DRAFT`, `SENT`, `APPROVED`, `REJECTED`, `EXPIRED`, `SUPERSEDED`, `CANCELLED` | `quotations.status` |
| `InvoiceStatus` | `DRAFT`, `ISSUED`, `PARTIALLY_PAID`, `PAID`, `VOID`, `CREDITED` | `invoices.status` |
| `FeeComponentType` | `SERVICE_FEE`, `GOVERNMENT_FEE`, `THIRD_PARTY_FEE` | `fee_components.type`, `quotation_items.component`, `invoice_items.component`, `liability_entries.component` |
| `AccountingTreatment` | `REVENUE`, `PASS_THROUGH_LIABILITY` | `fee_components.treatment` |
| `PaymentMethod` | `CASH`, `CARD_POS`, `BANK_TRANSFER`, `CHEQUE`, `ONLINE_GATEWAY` | `payments.method`, `reconciliation_records.method` |
| `PaymentStatus` | `PENDING`, `COMPLETED`, `FAILED`, `CANCELLED`, `PARTIALLY_REFUNDED`, `REFUNDED` | `payments.status` |
| `RefundStatus` | `REQUESTED`, `APPROVED`, `REJECTED`, `PROCESSING`, `COMPLETED`, `FAILED` | `refunds.status` |
| `AppointmentStatus` | `BOOKED`, `CONFIRMED`, `CHECKED_IN`, `IN_SERVICE`, `COMPLETED`, `CANCELLED`, `NO_SHOW`, `RESCHEDULED` | `appointments.status` |
| `QueueStatus` | `WAITING`, `CALLED`, `SERVING`, `COMPLETED`, `NO_SHOW`, `CANCELLED` | `queue_tokens.status` |
| `TaskStatus` | `OPEN`, `IN_PROGRESS`, `DONE`, `CANCELLED` | `tasks.status` |
| `NotificationChannel` | `EMAIL`, `SMS`, `WHATSAPP`, `IN_APP`, `PUSH` | `notification_templates.channel`, `notifications.channel`, `notification_preferences.channel` |
| `NotificationStatus` | `QUEUED`, `SENT`, `DELIVERED`, `FAILED`, `SUPPRESSED` | `notifications.status` |
| `DeliveryStatus` | `PENDING`, `SENT`, `DELIVERED`, `FAILED` | `notification_deliveries.status` |
| `ReminderStatus` | `ACTIVE`, `PAUSED`, `COMPLETED`, `CANCELLED` | `reminder_schedules.status` |
| `TicketStatus` | `OPEN`, `IN_PROGRESS`, `WAITING_CUSTOMER`, `RESOLVED`, `CLOSED` | `support_tickets.status` |
| `Visibility` | `INTERNAL`, `CUSTOMER` | `request_comments.visibility`, `support_messages.visibility` |
| `OutboxStatus` | `PENDING`, `PROCESSING`, `PROCESSED`, `FAILED` | `outbox_events.status` |
| `AutomationExecutionStatus` | `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `SKIPPED`, `DEAD_LETTER` | `automation_executions.status` |
| `AccessGrantStatus` | `REQUESTED`, `APPROVED`, `DENIED`, `REVOKED`, `EXPIRED` | `access_grants.status` |
| `DataRequestType` | `ACCESS`, `CORRECTION`, `DELETION`, `EXPORT` | `data_subject_requests.type` |
| `DataRequestStatus` | `RECEIVED`, `IN_REVIEW`, `APPROVED`, `REJECTED`, `COMPLETED` | `data_subject_requests.status` |
| `IntegrationStatus` | `DISABLED`, `CONFIGURED`, `ACTIVE`, `ERROR` | `integration_credentials_metadata.status` |

Several status-like columns are plain text with a check constraint or an API-level rule instead of an enum
type: `services.paymentPolicy`, `services.taxMode`, `quotations.discountApproval`, `credit_notes.status`,
`liability_entries.direction`, `request_documents.kind` (checked in the database, section 5.2);
`tenant_domains.app`, `branding_settings.mode`, `support_tickets.scope`, `tasks.type` / `tasks.source`,
`security_incidents.status` and others (checked by the API's validation schemas only).

## 5. Integrity rules from the migrations

Everything in this section is enforced by PostgreSQL (`database/migrations/0003_integrity.sql` and the guard of
`0002_tenant_isolation.sql`), independently of application code.

### 5.1 Uniqueness

- **Null-aware unique keys** (`NULLS NOT DISTINCT`): `roles (tenantId, key)`, `document_types (tenantId, key)`,
  `notification_templates (tenantId, eventKey, channel, language)`, `feature_flags (key, tenantId)`,
  `branding_settings (tenantId, branchId)`, `integration_credentials_metadata (tenantId, category, provider)`,
  `notification_preferences (tenantId, userId, customerId, channel, eventGroup)`,
  `data_retention_policies (tenantId, entity, documentTypeKey)`. Without this, PostgreSQL would allow two
  platform defaults (or two tenant-wide rows) with the same key.
- **At most one** published workflow version per definition, one published form version per service, one
  active operator and one active reviewer per request, one primary domain per tenant and app, one head office
  per tenant (partial unique indexes).
- Business numbers are unique per tenant: `customerNo`, `accountNo`, `requestNo`, `quotationNo`, `invoiceNo`,
  `paymentNo`, `refundNo`, `creditNoteNo`, `ticketNo`; queue token numbers per branch and day.
- Globally unique: `users.email`, `users.phone`, `tenants.slug`, `tenant_domains.domain`,
  `subscription_invoices.number`, `coupons.code`, `subscription_plans.key`, `sessions.refreshTokenHash`,
  `document_versions.storageKey`, `document_shares.tokenHash`, `payments (gateway, gatewayPaymentRef)`,
  `payment_webhook_events (gateway, eventId)`.

### 5.2 Check constraints (41)

| Table | Constraint | Condition |
| --- | --- | --- |
| `users` | `users_email_lowercase` | `"email" = lower("email")` |
| `users` | `users_phone_e164` | `"phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$'` |
| `tenants` | `tenants_slug_format` | `"slug" ~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$'` |
| `tenants` | `tenants_tax_rate_range` | `"taxRatePercent" >= 0 AND "taxRatePercent" <= 100` |
| `tenants` | `tenants_currency_iso` | `"defaultCurrency" ~ '^[A-Z]{3}$'` |
| `staff_schedules` | `staff_schedules_weekday` | `"weekday" BETWEEN 0 AND 6 AND "startTime" < "endTime"` |
| `subscription_plans` | `subscription_plans_prices` | `"monthlyPrice" >= 0 AND "annualPrice" >= 0 AND "trialDays" >= 0` |
| `coupons` | `coupons_one_kind` | `("percentOff" IS NOT NULL AND "amountOff" IS NULL AND "percentOff" > 0 AND "percentOff" <= 100) OR ("percentOff" IS NULL AND "amountOff" IS NOT NULL AND "amountOff" > 0)` |
| `subscriptions` | `subscriptions_period_order` | `"currentPeriodEnd" > "currentPeriodStart"` |
| `subscription_invoices` | `subscription_invoices_amounts` | `"subtotal" >= 0 AND "discount" >= 0 AND "tax" >= 0 AND "total" >= 0 AND "total" = "subtotal" - "discount" + "tax"` |
| `tenant_domains` | `tenant_domains_lowercase_fqdn` | `"domain" = lower("domain") AND "domain" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'` |
| `branding_settings` | `branding_hex_colours` | `("primaryColor" IS NULL OR "primaryColor" ~ '^#[0-9A-Fa-f]{6}$') AND ("secondaryColor" IS NULL OR "secondaryColor" ~ '^#[0-9A-Fa-f]{6}$') AND ("accentColor" IS NULL OR "accentColor" ~ '^#[0-9A-Fa-f]{6}$')` |
| `number_sequences` | `number_sequences_positive` | `"nextValue" >= 1` |
| `corporate_accounts` | `corporate_accounts_terms` | `"paymentTermsDays" >= 0 AND ("creditLimit" IS NULL OR "creditLimit" >= 0)` |
| `corporate_prices` | `corporate_prices_non_negative` | `"serviceFee" >= 0` |
| `services` | `services_payment_policy` | `"paymentPolicy" IN ('BEFORE_PROCESSING', 'AFTER_COMPLETION', 'DEPOSIT')` |
| `services` | `services_tax_mode` | `"taxMode" IN ('SERVICE_FEE_ONLY', 'ALL_COMPONENTS', 'NONE')` |
| `services` | `services_deposit_percent` | `"depositPercent" IS NULL OR ("depositPercent" > 0 AND "depositPercent" <= 100)` |
| `service_prices` | `service_prices_non_negative` | `"serviceFee" >= 0 AND "governmentFeeEstimate" >= 0 AND "thirdPartyFeeEstimate" >= 0 AND "currency" ~ '^[A-Z]{3}$'` |
| `request_documents` | `request_documents_kind` | `"kind" IN ('INPUT', 'COMPLETION')` |
| `document_versions` | `document_versions_size` | `"sizeBytes" >= 0 AND "versionNo" >= 1` |
| `document_shares` | `document_shares_limits` | `"maxDownloads" >= 1 AND "downloadCount" >= 0` |
| `fee_components` | `fee_components_service_fee_is_revenue` | `"type" <> 'SERVICE_FEE' OR "treatment" = 'REVENUE'` |
| `quotations` | `quotations_totals` | `"subtotalServiceFee" >= 0 AND "subtotalGovernmentFee" >= 0 AND "subtotalThirdParty" >= 0 AND "discountTotal" >= 0 AND "taxTotal" >= 0 AND "total" >= 0 AND "currency" ~ '^[A-Z]{3}$' AND "total" = "subtotalServiceFee" + "subtotalGovernmentFee" + "subtotalThirdParty" - "discountTotal" + "taxTotal"` |
| `quotations` | `quotations_discount_approval` | `"discountApproval" IN ('NONE', 'PENDING', 'APPROVED', 'REJECTED')` |
| `quotation_items` | `quotation_items_amounts` | `"quantity" > 0 AND "unitAmount" >= 0 AND "discountAmount" >= 0 AND "taxAmount" >= 0 AND "lineTotal" >= 0 AND "taxRatePercent" >= 0 AND "taxRatePercent" <= 100` |
| `invoices` | `invoices_totals` | `"subtotalServiceFee" >= 0 AND "subtotalGovernmentFee" >= 0 AND "subtotalThirdParty" >= 0 AND "discountTotal" >= 0 AND "taxTotal" >= 0 AND "total" >= 0 AND "currency" ~ '^[A-Z]{3}$' AND "total" = "subtotalServiceFee" + "subtotalGovernmentFee" + "subtotalThirdParty" - "discountTotal" + "taxTotal"` |
| `invoices` | `invoices_balance` | `"amountPaid" >= 0 AND "amountCredited" >= 0 AND "amountRefunded" >= 0 AND "amountRefunded" <= "amountPaid" AND "balanceDue" >= 0 AND "balanceDue" = "total" - "amountCredited" - "amountPaid" + "amountRefunded"` |
| `invoice_items` | `invoice_items_amounts` | `"quantity" > 0 AND "unitAmount" >= 0 AND "discountAmount" >= 0 AND "taxAmount" >= 0 AND "lineTotal" >= 0 AND "taxRatePercent" >= 0 AND "taxRatePercent" <= 100` |
| `payments` | `payments_amounts` | `"amount" > 0 AND "refundedAmount" >= 0 AND "refundedAmount" <= "amount" AND "currency" ~ '^[A-Z]{3}$'` |
| `payments` | `payments_gateway_fields` | `"method" <> 'ONLINE_GATEWAY' OR "gateway" IS NOT NULL` |
| `payment_allocations` | `payment_allocations_positive` | `"amount" > 0` |
| `refunds` | `refunds_positive` | `"amount" > 0 AND "currency" ~ '^[A-Z]{3}$'` |
| `credit_notes` | `credit_notes_positive` | `"amount" > 0 AND "taxAmount" >= 0 AND "status" IN ('ISSUED', 'VOID')` |
| `expenses` | `expenses_positive` | `"amount" > 0 AND "currency" ~ '^[A-Z]{3}$'` |
| `liability_entries` | `liability_entries_valid` | `"amount" > 0 AND "direction" IN ('ACCRUAL', 'REMITTANCE', 'REVERSAL') AND "component" <> 'SERVICE_FEE'` |
| `appointment_slot_configs` | `slot_configs_valid` | `"weekday" BETWEEN 0 AND 6 AND "startTime" < "endTime" AND "slotMinutes" BETWEEN 5 AND 480 AND "capacity" >= 1` |
| `appointments` | `appointments_time_order` | `"endsAt" > "startsAt"` |
| `appointments` | `appointments_has_person` | `"customerId" IS NOT NULL OR "guestName" IS NOT NULL` |
| `customer_feedback` | `customer_feedback_rating` | `"rating" BETWEEN 1 AND 5` |
| `access_grants` | `access_grants_duration` | `"durationMinutes" BETWEEN 5 AND 1440 AND char_length("reason") >= 10` |

### 5.3 Append-only tables

`audit_logs`, `security_events`, `request_status_history`, `document_access_logs`, `consent_records`,
`payment_allocations` and `liability_entries` carry the trigger `append_only`
(`BEFORE UPDATE OR DELETE ... reject_modification()`): any update or delete fails with
"<table> is append-only". For the first five the tenant role also has no `UPDATE` / `DELETE` grant.

### 5.4 Financial immutability

| Trigger | Table | Rule |
| --- | --- | --- |
| `invoice_immutability` | `invoices` | Once the status is not `DRAFT`: number, tenant, customer, currency, the five totals and `issuedAt` cannot change; the invoice cannot return to `DRAFT` or be deleted; a `VOID` invoice stays void. Paid / credited / refunded amounts, balance and status remain updatable (within the check constraints). |
| `items_frozen` | `invoice_items`, `quotation_items` | No insert, update or delete of lines once the parent document is not `DRAFT`. |
| `payment_immutability` | `payments` | Payments are never deleted. Once `COMPLETED` (or refunded): amount, currency, method, tenant, number, customer and `receivedAt` cannot change, and the status can only move among `COMPLETED`, `PARTIALLY_REFUNDED`, `REFUNDED`. |
| `amount_immutability` | `refunds`, `credit_notes` | Never deleted; amount and currency cannot change. |
| `allocation_within_payment` | `payment_allocations` | The sum of the allocations of a payment cannot exceed its amount (the payment row is locked while checking). |

The API maps these errors to `409 IMMUTABLE_RECORD`.

### 5.5 Cross-tenant foreign-key guard

A foreign key alone would let a row of tenant A point at a row of tenant B. The trigger
`same_tenant_guard` (`BEFORE INSERT OR UPDATE ... assert_same_tenant('<column>', '<parent table>', ...)`) is
installed on 61 tables and checks 104 foreign-key columns: for each non-null reference it reads the
parent's `tenantId` (as `SECURITY DEFINER`, so row-level security cannot hide the parent) and raises
"cross-tenant reference blocked" when it differs from the row's own `tenantId`. A parent without a tenant
(a platform default) is accepted. The column list is generated from the Prisma relations, so every declared
relation between two tenant-scoped tables is covered; the soft references of section 1 (actor columns and a
few id columns without a relation, for example `tasks.branchId` or `quotation_items.serviceId`) are not
foreign keys and are validated by application code only.

### 5.6 The controlled purge exception

All the triggers of 5.3 and 5.4 start with `IF typease_purge_allowed() THEN RETURN ...`. That function is
true only when the transaction-local setting `typease.allow_purge` is `on` **and** the current user is not
`typease_app`. Two code paths use it, both on the system connection and for one transaction at a time:

- the permanent deletion of an offboarded centre (`services/api/src/modules/platform/offboarding.service.ts`);
- the erasure of one person inside one centre (`services/api/src/modules/privacy/erasure-system.service.ts`),
  which keeps the entries of the append-only trails but removes that person's values from them (names,
  contact details and identity numbers in summaries and before / after values, free-text reasons, IP
  addresses of the person's own actions) and anonymises a login account that is used for nothing else.

The tenant role can set the variable but the function still answers false for it. "Append-only" therefore
means: no application code path on the tenant connection can change or delete these rows, and the two
system-connection paths above are the only exceptions.

## 6. Numbering

| Number | Format | Source |
| --- | --- | --- |
| Customer, corporate account, quotation, invoice, payment, receipt, refund, credit note, ticket | `CUS-000001`, `CORP-`, `QUO-`, `INV-`, `PAY-`, `RCT-`, `RFD-`, `CN-`, `TKT-` + six digits | `number_sequences`, one row per tenant and key (`customer`, `corporate`, `quotation`, `invoice`, `payment`, `receipt`, `refund`, `creditnote`, `ticket`) |
| Request | `<prefix>-000001`; the prefix is `tenants.settings.requestNumberPrefix` (default `TE`) | `number_sequences`, key `request` |
| Queue token | `<letter>-001` per branch and day; the letter is the service category | `number_sequences`, key `queue:<branchId>:<yyyy-mm-dd>` |
| Subscription invoice | `TE-SUB-000001`, global | counter row `subscriptions.invoice_sequence` in `platform_settings`, locked inside the invoice's transaction |
| Draft invoice | `DRAFT-<random>` until issued | generated; replaced by the `INV-` number at issue time |

`SequenceService.nextValue` is an `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` on the counter row. The row
stays locked until the surrounding transaction commits, so numbers are gap-free (a rolled-back transaction
does not consume one) and two concurrent transactions never receive the same number. The price is that two
transactions taking the same counter of the same centre run one after the other.

## 7. Migration procedure

Migrations are hand-reviewed SQL files in `database/migrations/`, applied by
`database/scripts/migrate.ts`. Prisma's migration engine is not used, because row-level security, triggers,
partial indexes and check constraints cannot be expressed in the Prisma schema.

| File | Content | Origin |
| --- | --- | --- |
| `0001_init.sql` | extension, enum types, tables, indexes, foreign keys | generated from the Prisma schema by `scripts/prisma-to-sql.ts` |
| `0002_tenant_isolation.sql` | the two runtime roles, `app_tenant_id()` / `app_user_id()`, grants, policies, the cross-tenant guard | generated by the same script from the schema and `rls-config.ts` |
| `0003_integrity.sql` | null-aware and partial unique indexes, check constraints, append-only and immutability triggers | written by hand |

Commands (root `package.json`; all need `DATABASE_MIGRATION_URL`, and `DATABASE_URL` / `DATABASE_SYSTEM_URL`
for the role passwords):

```bash
pnpm db:migrate                                        # apply pending files, then sync the role passwords
pnpm --filter @typease/database migrate:status         # list applied / pending files
ALLOW_DB_RESET=true pnpm db:reset                      # development only: drop the schema, migrate, seed
pnpm db:generate                                       # prisma generate (the typed client); needs no database
```

How the runner works: each file runs in its own transaction and is recorded in `schema_migrations` with a
SHA-256 checksum. A file that was changed after it was applied aborts the run. There are no down migrations.
`--reset` is refused when `NODE_ENV=production` or without `ALLOW_DB_RESET=true`.

### Changing the schema

1. Edit `database/prisma/schema.prisma`. A new table without a `tenantId` must be classified in
   `database/scripts/rls-config.ts` (`systemOnly` or `globalReadable`), otherwise SQL generation fails.
2. Print what the generator would produce and take the statements you need from it:
   `pnpm --filter @typease/database sql:generate`.
3. Write a **new** numbered file `database/migrations/000N_<name>.sql`. For a new tenant table it must contain:
   the table, its indexes and foreign keys; `ENABLE ROW LEVEL SECURITY`; the `system_access` policy and grant
   for `typease_system`; the grant and the `tenant_isolation` policy for `typease_app`; the
   `same_tenant_guard` trigger for every foreign key that points at a tenant-scoped table; and any check
   constraint or immutability trigger the table needs. `scripts/production-readiness.mjs` fails when a table
   with a `tenantId` column has no tenant policy.
4. Never edit `0001`-`0003` or any other applied file (the checksum check will stop the deployment).
   `sql:generate -- --write` rewrites `0001` and `0002` and is only for the time before a first production
   deployment.
5. Regenerate the client and the shared entity types:
   `pnpm db:generate` and `pnpm --filter @typease/database types:generate`
   (writes `packages/types/src/generated/models.ts`).
6. Make the change backward compatible with the previous release (expand / contract); the reasons and the
   patterns are in [deployment/upgrades-and-rollbacks.md](deployment/upgrades-and-rollbacks.md).
7. Update this document (section 8).

The API test suite rebuilds the database `typease_test` from these files before every run
(`services/api/test/global-setup.ts`), as a non-superuser owner, so tests exercise the same policies and
triggers as production.

## 8. Checking and regenerating this document

The generated parts were built from three inputs: the models and enums of `schema.prisma`, the grants,
policies and guard triggers of `0002_tenant_isolation.sql`, and the constraints and triggers of
`0003_integrity.sql`. The counts the script reported: 107 models, 53 enums, 107 `CREATE TABLE`
statements, row-level security enabled on 107 tables, 61 guard triggers covering 104 columns, 41 check
constraints, 14 integrity triggers. A read-only query on the development database agreed: 107 tables with
row-level security, 211 policies, 75 triggers.

The generator script is not part of the repository. This check is, and should be run after every schema
change; it fails when a table or enum of the schema is not mentioned in this file:

```bash
node -e '
const fs = require("fs");
const schema = fs.readFileSync("database/prisma/schema.prisma", "utf8");
const doc = fs.readFileSync("docs/DATABASE_SCHEMA.md", "utf8");
const tables = [...schema.matchAll(/@@map\("([^"]+)"\)/g)].map((m) => m[1]);
const enums = [...schema.matchAll(/^enum (\w+)/gm)].map((m) => m[1]);
const missing = [...tables, ...enums].filter((n) => !doc.includes("`" + n + "`"));
console.log(tables.length + " tables, " + enums.length + " enums; missing from the document: " + (missing.join(", ") || "none"));
process.exit(missing.length ? 1 : 0);'
```

To compare the document with a live database (as the schema owner):

```sql
-- tables, and whether row-level security is on
SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1;
-- policies per table and role
SELECT tablename, policyname, roles, cmd, qual FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2;
-- what the tenant role may do
SELECT table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type)
FROM information_schema.role_table_grants WHERE grantee = 'typease_app' GROUP BY 1 ORDER BY 1;
-- triggers
SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal ORDER BY 1, 2;
```

`scripts/production-readiness.mjs` performs the security-relevant part of this comparison automatically
(migrations applied with matching checksums, role attributes, a tenant policy on every table with a `tenantId`
column, every trigger of the migration files present and enabled).
