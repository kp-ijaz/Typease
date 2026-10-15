-- TypEase baseline schema. Generated from prisma/schema.prisma by scripts/prisma-to-sql.ts.
-- Do not edit after first deployment: add a new numbered migration instead.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "PlatformRole" AS ENUM ('SUPER_ADMIN', 'SUPPORT_AGENT');
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "TenantStatus" AS ENUM ('ONBOARDING', 'PENDING_APPROVAL', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'ARCHIVED');
CREATE TYPE "MembershipKind" AS ENUM ('STAFF', 'CUSTOMER', 'CORPORATE');
CREATE TYPE "MembershipStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'REMOVED');
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'GRACE', 'CANCELLED', 'EXPIRED');
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'ANNUAL');
CREATE TYPE "SubscriptionInvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');
CREATE TYPE "DomainStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'DISABLED');
CREATE TYPE "CustomerType" AS ENUM ('INDIVIDUAL', 'BUSINESS');
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'MERGED', 'ANONYMISED');
CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'WITHDRAWN');
CREATE TYPE "CorporateStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');
CREATE TYPE "ComplianceCapability" AS ENUM ('DOCUMENT_PREPARATION_ONLY', 'PARTNER_COORDINATION', 'DIRECT_AUTHORISED', 'INFORMATIONAL_ONLY');
CREATE TYPE "PublishStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "WorkflowStepType" AS ENUM ('CUSTOMER_FORM', 'DOCUMENT_UPLOAD', 'STAFF_VERIFICATION', 'INTERNAL_APPROVAL', 'CUSTOMER_APPROVAL', 'QUOTATION', 'PAYMENT', 'STAFF_TASK', 'EXTERNAL_PROCESSING', 'NOTIFICATION', 'DOCUMENT_GENERATION', 'COMPLETION', 'CONDITIONAL_BRANCH');
CREATE TYPE "RequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'AWAITING_CUSTOMER', 'UNDER_REVIEW', 'QUOTED', 'AWAITING_PAYMENT', 'READY_FOR_PROCESSING', 'IN_PREPARATION', 'PENDING_APPROVAL', 'READY_TO_SUBMIT', 'EXTERNAL_PROCESSING', 'RETURNED', 'REJECTED', 'FINAL_REVIEW', 'COMPLETED', 'CANCELLED');
CREATE TYPE "RequestPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "RequestSource" AS ENUM ('WALK_IN', 'ONLINE', 'MOBILE', 'CORPORATE');
CREATE TYPE "RequestPaymentStatus" AS ENUM ('NOT_REQUIRED', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED');
CREATE TYPE "SubmissionChannel" AS ENUM ('MANUAL_PORTAL', 'AUTHORISED_PARTNER', 'OFFICIAL_API');
CREATE TYPE "StatusSource" AS ENUM ('INTERNAL', 'STAFF_ENTERED', 'PARTNER_PROVIDED', 'VERIFIED_OFFICIAL');
CREATE TYPE "ChecklistStatus" AS ENUM ('MISSING', 'UPLOADED', 'VERIFIED', 'REJECTED', 'WAIVED');
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "ExecutionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED', 'FAILED');
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'ACTIVE', 'COMPLETED', 'SKIPPED', 'FAILED', 'TIMED_OUT', 'CANCELLED');
CREATE TYPE "ActorType" AS ENUM ('STAFF', 'CUSTOMER', 'CORPORATE', 'PLATFORM', 'SYSTEM', 'AUTOMATION');
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING_UPLOAD', 'PENDING_SCAN', 'AVAILABLE', 'QUARANTINED', 'DELETED');
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REJECTED');
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'ERROR', 'SKIPPED');
CREATE TYPE "OcrStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REVIEWED');
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED');
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID', 'CREDITED');
CREATE TYPE "FeeComponentType" AS ENUM ('SERVICE_FEE', 'GOVERNMENT_FEE', 'THIRD_PARTY_FEE');
CREATE TYPE "AccountingTreatment" AS ENUM ('REVENUE', 'PASS_THROUGH_LIABILITY');
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD_POS', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE_GATEWAY');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED');
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'CONFIRMED', 'CHECKED_IN', 'IN_SERVICE', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'RESCHEDULED');
CREATE TYPE "QueueStatus" AS ENUM ('WAITING', 'CALLED', 'SERVING', 'COMPLETED', 'NO_SHOW', 'CANCELLED');
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS', 'WHATSAPP', 'IN_APP', 'PUSH');
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED');
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED');
CREATE TYPE "ReminderStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED');
CREATE TYPE "Visibility" AS ENUM ('INTERNAL', 'CUSTOMER');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');
CREATE TYPE "AutomationExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'DEAD_LETTER');
CREATE TYPE "AccessGrantStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DENIED', 'REVOKED', 'EXPIRED');
CREATE TYPE "DataRequestType" AS ENUM ('ACCESS', 'CORRECTION', 'DELETION', 'EXPORT');
CREATE TYPE "DataRequestStatus" AS ENUM ('RECEIVED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED');
CREATE TYPE "IntegrationStatus" AS ENUM ('DISABLED', 'CONFIGURED', 'ACTIVE', 'ERROR');

CREATE TABLE "users" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL,
  "emailVerifiedAt" TIMESTAMPTZ(3),
  "phone" TEXT,
  "phoneVerifiedAt" TIMESTAMPTZ(3),
  "passwordHash" TEXT,
  "fullName" TEXT NOT NULL,
  "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
  "platformRole" "PlatformRole",
  "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
  "mfaSecretEnc" TEXT,
  "mfaRecoveryHashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMPTZ(3),
  "lastLoginAt" TIMESTAMPTZ(3),
  "passwordChangedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "tenantId" UUID,
  "membershipId" UUID,
  "app" TEXT NOT NULL,
  "refreshTokenHash" TEXT NOT NULL,
  "familyId" UUID NOT NULL,
  "supportGrantId" UUID,
  "mfaVerified" BOOLEAN NOT NULL DEFAULT false,
  "userAgent" TEXT,
  "ip" TEXT,
  "deviceName" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  "revokedReason" TEXT,
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auth_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID,
  "tenantId" UUID,
  "type" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "target" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "meta" JSONB NOT NULL DEFAULT '{}',
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "consumedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "login_activity" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID,
  "email" TEXT,
  "tenantId" UUID,
  "app" TEXT,
  "success" BOOLEAN NOT NULL,
  "reason" TEXT,
  "ip" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "login_activity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tenants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "legalName" TEXT,
  "status" "TenantStatus" NOT NULL DEFAULT 'ONBOARDING',
  "country" TEXT NOT NULL DEFAULT 'AE',
  "emirate" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Dubai',
  "defaultCurrency" TEXT NOT NULL DEFAULT 'AED',
  "defaultLanguage" TEXT NOT NULL DEFAULT 'en',
  "contactEmail" TEXT,
  "contactPhone" TEXT,
  "tradeLicenceNo" TEXT,
  "taxRegistrationNo" TEXT,
  "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 5,
  "aiEnabled" BOOLEAN NOT NULL DEFAULT false,
  "onboardingStep" INTEGER NOT NULL DEFAULT 0,
  "onboardingData" JSONB NOT NULL DEFAULT '{}',
  "settings" JSONB NOT NULL DEFAULT '{}',
  "approvedAt" TIMESTAMPTZ(3),
  "approvedById" UUID,
  "suspendedAt" TIMESTAMPTZ(3),
  "suspensionReason" TEXT,
  "archivedAt" TIMESTAMPTZ(3),
  "offboardingAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "roles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "kind" "MembershipKind" NOT NULL,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "permissions" (
  "key" TEXT NOT NULL,
  "groupName" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  CONSTRAINT "permissions_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "role_permissions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "roleId" UUID NOT NULL,
  "permissionKey" TEXT NOT NULL,
  CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tenant_memberships" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  "kind" "MembershipKind" NOT NULL,
  "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  "customerId" UUID,
  "corporateAccountId" UUID,
  "corporateEmployeeId" UUID,
  "allBranches" BOOLEAN NOT NULL DEFAULT false,
  "jobTitle" TEXT,
  "isAvailable" BOOLEAN NOT NULL DEFAULT true,
  "invitedById" UUID,
  "invitedAt" TIMESTAMPTZ(3),
  "joinedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_memberships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "membership_branches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  CONSTRAINT "membership_branches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "staff_schedules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "weekday" INTEGER NOT NULL,
  "startTime" TEXT NOT NULL,
  "endTime" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "staff_schedules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "staff_skills" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "serviceId" UUID NOT NULL,
  CONSTRAINT "staff_skills_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "branches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT,
  "address" TEXT,
  "emirate" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Dubai',
  "isHeadOffice" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "workingHours" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "monthlyPrice" DECIMAL(14,2) NOT NULL,
  "annualPrice" DECIMAL(14,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "trialDays" INTEGER NOT NULL DEFAULT 14,
  "limits" JSONB NOT NULL,
  "features" JSONB NOT NULL,
  "isPublic" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "coupons" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" TEXT NOT NULL,
  "description" TEXT,
  "percentOff" DECIMAL(5,2),
  "amountOff" DECIMAL(14,2),
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "durationMonths" INTEGER,
  "maxRedemptions" INTEGER,
  "redeemedCount" INTEGER NOT NULL DEFAULT 0,
  "planKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "validFrom" TIMESTAMPTZ(3),
  "validUntil" TIMESTAMPTZ(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "planId" UUID NOT NULL,
  "status" "SubscriptionStatus" NOT NULL,
  "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
  "currentPeriodStart" TIMESTAMPTZ(3) NOT NULL,
  "currentPeriodEnd" TIMESTAMPTZ(3) NOT NULL,
  "trialEndsAt" TIMESTAMPTZ(3),
  "graceEndsAt" TIMESTAMPTZ(3),
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
  "cancelledAt" TIMESTAMPTZ(3),
  "cancellationReason" TEXT,
  "pendingPlanId" UUID,
  "pendingCycle" "BillingCycle",
  "couponId" UUID,
  "couponEndsAt" TIMESTAMPTZ(3),
  "gatewayCustomerRef" TEXT,
  "renewalReminderAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_invoices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "number" TEXT NOT NULL,
  "status" "SubscriptionInvoiceStatus" NOT NULL DEFAULT 'OPEN',
  "reason" TEXT NOT NULL DEFAULT 'RENEWAL',
  "periodStart" TIMESTAMPTZ(3) NOT NULL,
  "periodEnd" TIMESTAMPTZ(3) NOT NULL,
  "subtotal" DECIMAL(14,2) NOT NULL,
  "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "total" DECIMAL(14,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "lines" JSONB NOT NULL DEFAULT '[]',
  "dueAt" TIMESTAMPTZ(3) NOT NULL,
  "paidAt" TIMESTAMPTZ(3),
  "paymentMethod" TEXT,
  "gatewayRef" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "subscriptionId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "actorId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "usage_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "metric" TEXT NOT NULL,
  "periodKey" TEXT NOT NULL,
  "quantity" DECIMAL(20,2) NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tenant_domains" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "domain" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'CUSTOM',
  "app" TEXT NOT NULL DEFAULT 'customer',
  "verificationToken" TEXT NOT NULL,
  "status" "DomainStatus" NOT NULL DEFAULT 'PENDING',
  "verifiedAt" TIMESTAMPTZ(3),
  "lastCheckedAt" TIMESTAMPTZ(3),
  "lastCheckError" TEXT,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_domains_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "branding_settings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID,
  "mode" TEXT NOT NULL DEFAULT 'TYPEASE',
  "businessName" TEXT,
  "businessNameAr" TEXT,
  "logoAssetKey" TEXT,
  "faviconAssetKey" TEXT,
  "primaryColor" TEXT,
  "secondaryColor" TEXT,
  "accentColor" TEXT,
  "websiteTitle" TEXT,
  "tagline" TEXT,
  "supportEmail" TEXT,
  "supportPhone" TEXT,
  "emailFromName" TEXT,
  "emailFromAddress" TEXT,
  "emailSenderVerified" BOOLEAN NOT NULL DEFAULT false,
  "invoiceFooter" TEXT,
  "receiptFooter" TEXT,
  "publicCatalogueEnabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "branding_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "feature_flags" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" TEXT NOT NULL,
  "tenantId" UUID,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "platform_settings" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "number_sequences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "nextValue" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "number_sequences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "customerNo" TEXT NOT NULL,
  "type" "CustomerType" NOT NULL DEFAULT 'INDIVIDUAL',
  "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
  "fullName" TEXT NOT NULL,
  "fullNameAr" TEXT,
  "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
  "email" TEXT,
  "phone" TEXT,
  "nationality" TEXT,
  "dateOfBirth" DATE,
  "address" JSONB,
  "emiratesIdEnc" TEXT,
  "emiratesIdHash" TEXT,
  "emiratesIdLast4" TEXT,
  "emiratesIdExpiry" DATE,
  "passportNoEnc" TEXT,
  "passportNoHash" TEXT,
  "passportNoLast4" TEXT,
  "passportCountry" TEXT,
  "passportExpiry" DATE,
  "corporateAccountId" UUID,
  "communicationPrefs" JSONB NOT NULL DEFAULT '{"email":true,"sms":true,"whatsapp":false,"push":true}',
  "marketingOptIn" BOOLEAN NOT NULL DEFAULT false,
  "mergedIntoId" UUID,
  "lastActivityAt" TIMESTAMPTZ(3),
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_contacts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "label" TEXT,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_consents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "purpose" TEXT NOT NULL,
  "status" "ConsentStatus" NOT NULL,
  "lawfulBasis" TEXT NOT NULL DEFAULT 'CONSENT',
  "noticeVersion" TEXT,
  "grantedAt" TIMESTAMPTZ(3),
  "withdrawnAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_consents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_notes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "authorId" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "isPinned" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_tags" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_tags_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_tag_assignments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "tagId" UUID NOT NULL,
  CONSTRAINT "customer_tag_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "corporate_accounts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "accountNo" TEXT NOT NULL,
  "companyName" TEXT NOT NULL,
  "companyNameAr" TEXT,
  "tradeLicenceNo" TEXT,
  "tradeLicenceAuthority" TEXT,
  "tradeLicenceExpiry" DATE,
  "taxRegistrationNo" TEXT,
  "billingEmail" TEXT,
  "billingAddress" JSONB,
  "paymentTermsDays" INTEGER NOT NULL DEFAULT 0,
  "creditLimit" DECIMAL(14,2),
  "creditApproved" BOOLEAN NOT NULL DEFAULT false,
  "status" "CorporateStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  "verifiedById" UUID,
  "verifiedAt" TIMESTAMPTZ(3),
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "corporate_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "corporate_members" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "corporateAccountId" UUID NOT NULL,
  "userId" UUID,
  "fullName" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "role" TEXT NOT NULL DEFAULT 'ADMIN',
  "isAuthorisedSignatory" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'INVITED',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "corporate_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "corporate_employees" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "corporateAccountId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "employeeNo" TEXT,
  "designation" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "corporate_employees_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "corporate_agreements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "corporateAccountId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "terms" TEXT,
  "startsOn" DATE NOT NULL,
  "endsOn" DATE,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "corporate_agreements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "corporate_prices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "corporateAccountId" UUID NOT NULL,
  "serviceId" UUID NOT NULL,
  "serviceFee" DECIMAL(14,2) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "corporate_prices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_categories" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT,
  "description" TEXT,
  "icon" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_types" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT,
  "hasExpiry" BOOLEAN NOT NULL DEFAULT false,
  "ocrProfile" TEXT NOT NULL DEFAULT 'NONE',
  "reminderEnabled" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_types_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "services" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "categoryId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT,
  "description" TEXT,
  "descriptionAr" TEXT,
  "eligibilityGuidance" TEXT,
  "complianceCapability" "ComplianceCapability" NOT NULL DEFAULT 'DOCUMENT_PREPARATION_ONLY',
  "estimatedProcessingHours" INTEGER,
  "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
  "paymentPolicy" TEXT NOT NULL DEFAULT 'BEFORE_PROCESSING',
  "depositPercent" DECIMAL(5,2),
  "taxMode" TEXT NOT NULL DEFAULT 'SERVICE_FEE_ONLY',
  "onlineAvailable" BOOLEAN NOT NULL DEFAULT true,
  "isPublic" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "allBranches" BOOLEAN NOT NULL DEFAULT true,
  "staffGroupRoleKey" TEXT,
  "workflowDefinitionId" UUID,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_branches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "serviceId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  CONSTRAINT "service_branches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_prices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "serviceId" UUID NOT NULL,
  "branchId" UUID,
  "serviceFee" DECIMAL(14,2) NOT NULL,
  "governmentFeeEstimate" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "thirdPartyFeeEstimate" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "validFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validTo" TIMESTAMPTZ(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_prices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_requirements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "serviceId" UUID NOT NULL,
  "documentTypeKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "labelAr" TEXT,
  "description" TEXT,
  "isMandatory" BOOLEAN NOT NULL DEFAULT true,
  "allowReuse" BOOLEAN NOT NULL DEFAULT true,
  "maxAgeDays" INTEGER,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_requirements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_form_definitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "serviceId" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
  "schema" JSONB NOT NULL,
  "publishedAt" TIMESTAMPTZ(3),
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_form_definitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_definitions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "templateKey" TEXT,
  "publishedVersionId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "definitionId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
  "notes" TEXT,
  "publishedAt" TIMESTAMPTZ(3),
  "publishedById" UUID,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_steps" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "versionId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT,
  "type" "WorkflowStepType" NOT NULL,
  "position" INTEGER NOT NULL,
  "config" JSONB NOT NULL DEFAULT '{}',
  "conditions" JSONB,
  "branches" JSONB,
  "nextStepKey" TEXT,
  "onRejectStepKey" TEXT,
  "assigneeRoleKey" TEXT,
  "timeoutHours" INTEGER,
  "escalateToRoleKey" TEXT,
  "customerVisible" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "requestNo" TEXT NOT NULL,
  "customerId" UUID NOT NULL,
  "corporateAccountId" UUID,
  "serviceId" UUID NOT NULL,
  "serviceSnapshot" JSONB NOT NULL DEFAULT '{}',
  "status" "RequestStatus" NOT NULL DEFAULT 'DRAFT',
  "priority" "RequestPriority" NOT NULL DEFAULT 'NORMAL',
  "source" "RequestSource" NOT NULL DEFAULT 'WALK_IN',
  "paymentStatus" "RequestPaymentStatus" NOT NULL DEFAULT 'UNPAID',
  "assignedToId" UUID,
  "reviewerId" UUID,
  "customerInstructions" TEXT,
  "submittedAt" TIMESTAMPTZ(3),
  "targetDate" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "cancelledAt" TIMESTAMPTZ(3),
  "cancellationReason" TEXT,
  "submissionChannel" "SubmissionChannel",
  "externalStatus" TEXT,
  "externalStatusSource" "StatusSource",
  "externalStatusAt" TIMESTAMPTZ(3),
  "formDefinitionId" UUID,
  "workflowVersionId" UUID,
  "duplicateOfId" UUID,
  "renewalOfDocumentId" UUID,
  "reopenedCount" INTEGER NOT NULL DEFAULT 0,
  "trackingCodeHash" TEXT,
  "createdById" UUID,
  "createdByType" "ActorType" NOT NULL DEFAULT 'STAFF',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "service_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "request_fields" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'STAFF',
  "verified" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_fields_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "request_documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "requirementId" UUID,
  "documentTypeKey" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "labelAr" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'INPUT',
  "isMandatory" BOOLEAN NOT NULL DEFAULT true,
  "documentId" UUID,
  "status" "ChecklistStatus" NOT NULL DEFAULT 'MISSING',
  "rejectionReason" TEXT,
  "reviewedById" UUID,
  "reviewedAt" TIMESTAMPTZ(3),
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "request_status_history" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "fromStatus" "RequestStatus",
  "toStatus" "RequestStatus" NOT NULL,
  "actorId" UUID,
  "actorType" "ActorType" NOT NULL,
  "reason" TEXT,
  "customerVisible" BOOLEAN NOT NULL DEFAULT true,
  "customerMessage" TEXT,
  "meta" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_status_history_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "request_assignments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "assigneeId" UUID NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'OPERATOR',
  "method" TEXT NOT NULL DEFAULT 'MANUAL',
  "reason" TEXT,
  "assignedById" UUID,
  "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unassignedAt" TIMESTAMPTZ(3),
  CONSTRAINT "request_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "request_approvals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "stepKey" TEXT,
  "requestedById" UUID,
  "decidedById" UUID,
  "decidedAt" TIMESTAMPTZ(3),
  "comment" TEXT,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_approvals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "request_comments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "authorId" UUID,
  "authorType" "ActorType" NOT NULL,
  "authorName" TEXT,
  "body" TEXT NOT NULL,
  "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "request_external_references" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "channel" "SubmissionChannel" NOT NULL,
  "authorityName" TEXT,
  "referenceNo" TEXT NOT NULL,
  "partnerName" TEXT,
  "partnerReference" TEXT,
  "status" TEXT,
  "statusSource" "StatusSource" NOT NULL DEFAULT 'STAFF_ENTERED',
  "integrationId" UUID,
  "notes" TEXT,
  "recordedById" UUID,
  "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "request_external_references_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_executions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "versionId" UUID NOT NULL,
  "status" "ExecutionStatus" NOT NULL DEFAULT 'ACTIVE',
  "currentStepKey" TEXT,
  "migratedFromVersionId" UUID,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_executions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "workflow_step_executions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "executionId" UUID NOT NULL,
  "stepKey" TEXT NOT NULL,
  "stepName" TEXT NOT NULL,
  "stepType" "WorkflowStepType" NOT NULL,
  "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "dueAt" TIMESTAMPTZ(3),
  "escalatedAt" TIMESTAMPTZ(3),
  "actorId" UUID,
  "result" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_step_executions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "customerId" UUID,
  "corporateAccountId" UUID,
  "requestId" UUID,
  "documentTypeKey" TEXT NOT NULL,
  "category" TEXT,
  "title" TEXT NOT NULL,
  "currentVersionId" UUID,
  "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
  "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
  "verifiedById" UUID,
  "verifiedAt" TIMESTAMPTZ(3),
  "issuedDate" DATE,
  "expiryDate" DATE,
  "expiryVerified" BOOLEAN NOT NULL DEFAULT false,
  "isCompletionDocument" BOOLEAN NOT NULL DEFAULT false,
  "customerVisible" BOOLEAN NOT NULL DEFAULT true,
  "legalHold" BOOLEAN NOT NULL DEFAULT false,
  "retentionUntil" TIMESTAMPTZ(3),
  "uploadedById" UUID,
  "uploadedByType" "ActorType" NOT NULL DEFAULT 'STAFF',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(3),
  "deletedById" UUID,
  "purgeAfter" TIMESTAMPTZ(3),
  CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "versionNo" INTEGER NOT NULL,
  "storageKey" TEXT NOT NULL,
  "originalFilename" TEXT NOT NULL,
  "declaredMime" TEXT NOT NULL,
  "detectedMime" TEXT,
  "sizeBytes" BIGINT NOT NULL DEFAULT '0',
  "sha256" TEXT,
  "encryption" TEXT NOT NULL DEFAULT 'NONE',
  "encryptionMeta" JSONB,
  "uploadStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "uploadExpiresAt" TIMESTAMPTZ(3),
  "scanStatus" "ScanStatus" NOT NULL DEFAULT 'PENDING',
  "scanEngine" TEXT,
  "scanDetail" TEXT,
  "scannedAt" TIMESTAMPTZ(3),
  "uploadedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_access_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "versionId" UUID,
  "actorId" UUID,
  "actorType" "ActorType" NOT NULL,
  "action" TEXT NOT NULL,
  "supportGrantId" UUID,
  "ip" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_access_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_shares" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "recipient" TEXT,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "maxDownloads" INTEGER NOT NULL DEFAULT 3,
  "downloadCount" INTEGER NOT NULL DEFAULT 0,
  "revokedAt" TIMESTAMPTZ(3),
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_shares_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "document_verification_results" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "versionId" UUID,
  "reviewerId" UUID NOT NULL,
  "decision" TEXT NOT NULL,
  "reason" TEXT,
  "fieldsConfirmed" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_verification_results_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ocr_extraction_results" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "versionId" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "profile" TEXT NOT NULL,
  "status" "OcrStatus" NOT NULL DEFAULT 'QUEUED',
  "classification" TEXT,
  "classificationConfidence" DECIMAL(4,3),
  "fields" JSONB NOT NULL DEFAULT '[]',
  "warnings" JSONB NOT NULL DEFAULT '[]',
  "pages" INTEGER NOT NULL DEFAULT 0,
  "costUnits" DECIMAL(12,4) NOT NULL DEFAULT 0,
  "error" TEXT,
  "requestedById" UUID,
  "reviewedById" UUID,
  "reviewedAt" TIMESTAMPTZ(3),
  "reviewedFields" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "ocr_extraction_results_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_usage_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "documentId" UUID,
  "pages" INTEGER NOT NULL DEFAULT 0,
  "units" DECIMAL(12,4) NOT NULL DEFAULT 0,
  "costEstimate" DECIMAL(14,4) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "actorId" UUID,
  "success" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fee_components" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "type" "FeeComponentType" NOT NULL,
  "name" TEXT NOT NULL,
  "treatment" "AccountingTreatment" NOT NULL,
  "taxable" BOOLEAN NOT NULL DEFAULT false,
  "ledgerCode" TEXT,
  "reviewNote" TEXT,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fee_components_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quotations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "quotationNo" TEXT NOT NULL,
  "requestId" UUID,
  "customerId" UUID NOT NULL,
  "corporateAccountId" UUID,
  "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "subtotalServiceFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "subtotalGovernmentFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "subtotalThirdParty" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "validUntil" TIMESTAMPTZ(3),
  "notes" TEXT,
  "discountApproval" TEXT NOT NULL DEFAULT 'NONE',
  "discountRequestedById" UUID,
  "discountDecidedById" UUID,
  "discountReason" TEXT,
  "sentAt" TIMESTAMPTZ(3),
  "decidedAt" TIMESTAMPTZ(3),
  "decidedById" UUID,
  "decidedByType" "ActorType",
  "rejectionReason" TEXT,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quotation_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "quotationId" UUID NOT NULL,
  "serviceId" UUID,
  "description" TEXT NOT NULL,
  "component" "FeeComponentType" NOT NULL,
  "quantity" DECIMAL(10,2) NOT NULL DEFAULT 1,
  "unitAmount" DECIMAL(14,2) NOT NULL,
  "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "lineTotal" DECIMAL(14,2) NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "quotation_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invoices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "invoiceNo" TEXT NOT NULL,
  "requestId" UUID,
  "quotationId" UUID,
  "customerId" UUID NOT NULL,
  "corporateAccountId" UUID,
  "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "subtotalServiceFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "subtotalGovernmentFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "subtotalThirdParty" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "amountCredited" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "amountRefunded" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "balanceDue" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "issuedAt" TIMESTAMPTZ(3),
  "dueAt" TIMESTAMPTZ(3),
  "voidedAt" TIMESTAMPTZ(3),
  "voidReason" TEXT,
  "notes" TEXT,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "invoice_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "serviceId" UUID,
  "description" TEXT NOT NULL,
  "component" "FeeComponentType" NOT NULL,
  "quantity" DECIMAL(10,2) NOT NULL DEFAULT 1,
  "unitAmount" DECIMAL(14,2) NOT NULL,
  "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "lineTotal" DECIMAL(14,2) NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "paymentNo" TEXT NOT NULL,
  "receiptNo" TEXT,
  "customerId" UUID,
  "corporateAccountId" UUID,
  "method" "PaymentMethod" NOT NULL,
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "amount" DECIMAL(14,2) NOT NULL,
  "refundedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "gateway" TEXT,
  "gatewaySessionRef" TEXT,
  "gatewayPaymentRef" TEXT,
  "reference" TEXT,
  "idempotencyKey" TEXT,
  "failureReason" TEXT,
  "notes" TEXT,
  "receivedById" UUID,
  "receivedAt" TIMESTAMPTZ(3),
  "reconciliationId" UUID,
  "reconciledAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_allocations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "paymentId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refunds" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "refundNo" TEXT NOT NULL,
  "paymentId" UUID NOT NULL,
  "invoiceId" UUID,
  "requestId" UUID,
  "amount" DECIMAL(14,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "breakdown" JSONB NOT NULL DEFAULT '{}',
  "reason" TEXT NOT NULL,
  "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
  "method" TEXT,
  "requestedById" UUID NOT NULL,
  "decidedById" UUID,
  "decidedAt" TIMESTAMPTZ(3),
  "rejectionReason" TEXT,
  "processedAt" TIMESTAMPTZ(3),
  "gatewayRefundRef" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "credit_notes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "creditNoteNo" TEXT NOT NULL,
  "invoiceId" UUID NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "breakdown" JSONB NOT NULL DEFAULT '{}',
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ISSUED',
  "issuedById" UUID NOT NULL,
  "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "expenses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "category" TEXT NOT NULL,
  "requestId" UUID,
  "description" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "paidOn" DATE NOT NULL,
  "payee" TEXT,
  "reference" TEXT,
  "method" TEXT,
  "recordedById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "liability_entries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "component" "FeeComponentType" NOT NULL,
  "direction" TEXT NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "requestId" UUID,
  "invoiceId" UUID,
  "sourceType" TEXT NOT NULL,
  "sourceId" UUID NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "liability_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reconciliation_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID,
  "method" "PaymentMethod" NOT NULL,
  "gateway" TEXT,
  "periodStart" TIMESTAMPTZ(3) NOT NULL,
  "periodEnd" TIMESTAMPTZ(3) NOT NULL,
  "statementReference" TEXT,
  "expectedAmount" DECIMAL(14,2) NOT NULL,
  "settledAmount" DECIMAL(14,2) NOT NULL,
  "feeAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "difference" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "notes" TEXT,
  "reconciledById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reconciliation_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "payment_webhook_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "gateway" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "tenantId" UUID,
  "eventType" TEXT,
  "signatureValid" BOOLEAN NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "error" TEXT,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(3),
  CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "idempotency_keys" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "responseStatus" INTEGER,
  "responseBody" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "appointment_slot_configs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "serviceId" UUID,
  "weekday" INTEGER NOT NULL,
  "startTime" TEXT NOT NULL,
  "endTime" TEXT NOT NULL,
  "slotMinutes" INTEGER NOT NULL DEFAULT 30,
  "capacity" INTEGER NOT NULL DEFAULT 1,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointment_slot_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "branch_closures" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "date" DATE NOT NULL,
  "reason" TEXT,
  CONSTRAINT "branch_closures_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "appointments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "customerId" UUID,
  "guestName" TEXT,
  "guestPhone" TEXT,
  "serviceId" UUID,
  "requestId" UUID,
  "staffId" UUID,
  "startsAt" TIMESTAMPTZ(3) NOT NULL,
  "endsAt" TIMESTAMPTZ(3) NOT NULL,
  "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
  "source" TEXT NOT NULL DEFAULT 'STAFF',
  "notes" TEXT,
  "cancelledReason" TEXT,
  "rescheduledFromId" UUID,
  "checkedInAt" TIMESTAMPTZ(3),
  "reminderSentAt" TIMESTAMPTZ(3),
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "queue_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "queueDate" DATE NOT NULL,
  "tokenNo" TEXT NOT NULL,
  "categoryId" UUID,
  "customerId" UUID,
  "appointmentId" UUID,
  "status" "QueueStatus" NOT NULL DEFAULT 'WAITING',
  "counter" TEXT,
  "servedById" UUID,
  "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "calledAt" TIMESTAMPTZ(3),
  "servedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "queue_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID,
  "requestId" UUID,
  "customerId" UUID,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "type" TEXT NOT NULL DEFAULT 'GENERAL',
  "priority" "RequestPriority" NOT NULL DEFAULT 'NORMAL',
  "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "stepKey" TEXT,
  "roleKey" TEXT,
  "dueAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "completedById" UUID,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "task_assignments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "taskId" UUID NOT NULL,
  "assigneeId" UUID NOT NULL,
  "assignedById" UUID,
  "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unassignedAt" TIMESTAMPTZ(3),
  CONSTRAINT "task_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_templates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "eventKey" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "language" TEXT NOT NULL DEFAULT 'en',
  "name" TEXT NOT NULL,
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "whatsappTemplateName" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notifications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "recipientUserId" UUID,
  "recipientCustomerId" UUID,
  "recipientAddress" TEXT,
  "eventKey" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "language" TEXT NOT NULL DEFAULT 'en',
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
  "suppressedReason" TEXT,
  "relatedType" TEXT,
  "relatedId" UUID,
  "dedupeKey" TEXT,
  "readAt" TIMESTAMPTZ(3),
  "sentAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_deliveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "notificationId" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "providerMessageId" TEXT,
  "error" TEXT,
  "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_preferences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "userId" UUID,
  "customerId" UUID,
  "channel" "NotificationChannel" NOT NULL,
  "eventGroup" TEXT NOT NULL DEFAULT '*',
  "enabled" BOOLEAN NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "device_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "platform" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reminder_schedules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "customerId" UUID,
  "corporateAccountId" UUID,
  "documentId" UUID,
  "documentTypeKey" TEXT NOT NULL,
  "subjectLabel" TEXT NOT NULL,
  "expiryDate" DATE NOT NULL,
  "offsetsDays" INTEGER[] NOT NULL DEFAULT ARRAY[90, 60, 30, 15, 7]::INTEGER[],
  "status" "ReminderStatus" NOT NULL DEFAULT 'ACTIVE',
  "renewalRequestId" UUID,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reminder_schedules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "reminder_dispatches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "scheduleId" UUID NOT NULL,
  "offsetDays" INTEGER NOT NULL,
  "dueOn" DATE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "notificationId" UUID,
  "detail" TEXT,
  "processedAt" TIMESTAMPTZ(3),
  CONSTRAINT "reminder_dispatches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sla_policies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "priority" "RequestPriority" NOT NULL,
  "firstResponseMinutes" INTEGER NOT NULL,
  "resolutionMinutes" INTEGER NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support_tickets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "ticketNo" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'CUSTOMER',
  "customerId" UUID,
  "requestId" UUID,
  "raisedByUserId" UUID,
  "subject" TEXT NOT NULL,
  "category" TEXT,
  "priority" "RequestPriority" NOT NULL DEFAULT 'NORMAL',
  "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
  "assigneeId" UUID,
  "platformAssigneeId" UUID,
  "firstResponseDueAt" TIMESTAMPTZ(3),
  "resolutionDueAt" TIMESTAMPTZ(3),
  "firstRespondedAt" TIMESTAMPTZ(3),
  "resolvedAt" TIMESTAMPTZ(3),
  "closedAt" TIMESTAMPTZ(3),
  "resolutionSummary" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "ticketId" UUID NOT NULL,
  "authorUserId" UUID,
  "authorType" "ActorType" NOT NULL,
  "authorName" TEXT,
  "body" TEXT NOT NULL,
  "visibility" "Visibility" NOT NULL DEFAULT 'CUSTOMER',
  "attachments" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_feedback" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "requestId" UUID,
  "ticketId" UUID,
  "rating" INTEGER NOT NULL,
  "comment" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_feedback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outbox_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(3),
  "error" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "automation_rules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "templateKey" TEXT,
  "triggerEvent" TEXT NOT NULL,
  "conditions" JSONB NOT NULL DEFAULT '{}',
  "actions" JSONB NOT NULL DEFAULT '[]',
  "isEnabled" BOOLEAN NOT NULL DEFAULT false,
  "maxRetries" INTEGER NOT NULL DEFAULT 3,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "automation_executions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "ruleId" UUID NOT NULL,
  "eventId" UUID NOT NULL,
  "eventType" TEXT NOT NULL,
  "status" "AutomationExecutionStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "actionResults" JSONB NOT NULL DEFAULT '[]',
  "error" TEXT,
  "startedAt" TIMESTAMPTZ(3),
  "finishedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "automation_executions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scheduled_reports" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "reportKey" TEXT NOT NULL,
  "params" JSONB NOT NULL DEFAULT '{}',
  "format" TEXT NOT NULL DEFAULT 'XLSX',
  "frequency" TEXT NOT NULL,
  "recipients" TEXT[] NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "nextRunAt" TIMESTAMPTZ(3) NOT NULL,
  "lastRunAt" TIMESTAMPTZ(3),
  "lastStatus" TEXT,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scheduled_reports_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "audit_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "actorUserId" UUID,
  "actorType" "ActorType" NOT NULL,
  "actorLabel" TEXT,
  "action" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT,
  "summary" TEXT,
  "before" JSONB,
  "after" JSONB,
  "supportGrantId" UUID,
  "requestId" TEXT,
  "ip" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "security_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "userId" UUID,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'LOW',
  "details" JSONB NOT NULL DEFAULT '{}',
  "ip" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "access_grants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "requestedById" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "ticketId" UUID,
  "status" "AccessGrantStatus" NOT NULL DEFAULT 'REQUESTED',
  "durationMinutes" INTEGER NOT NULL DEFAULT 60,
  "decidedById" UUID,
  "decidedAt" TIMESTAMPTZ(3),
  "decisionNote" TEXT,
  "startsAt" TIMESTAMPTZ(3),
  "expiresAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "access_grants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "consent_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "customerId" UUID,
  "userId" UUID,
  "purpose" TEXT NOT NULL,
  "status" "ConsentStatus" NOT NULL,
  "lawfulBasis" TEXT NOT NULL DEFAULT 'CONSENT',
  "noticeVersion" TEXT,
  "capturedVia" TEXT NOT NULL,
  "capturedById" UUID,
  "ip" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "data_retention_policies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "entity" TEXT NOT NULL,
  "documentTypeKey" TEXT,
  "retainDays" INTEGER NOT NULL,
  "action" TEXT NOT NULL DEFAULT 'DELETE',
  "legalBasisNote" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "data_retention_policies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "data_subject_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "requestedByUserId" UUID,
  "type" "DataRequestType" NOT NULL,
  "status" "DataRequestStatus" NOT NULL DEFAULT 'RECEIVED',
  "details" TEXT,
  "decisionNote" TEXT,
  "retentionException" TEXT,
  "handledById" UUID,
  "exportDocumentId" UUID,
  "dueAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "data_subject_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "security_incidents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "affectedData" TEXT,
  "personalDataInvolved" BOOLEAN NOT NULL DEFAULT false,
  "notificationRequired" BOOLEAN,
  "authorityNotifiedAt" TIMESTAMPTZ(3),
  "individualsNotifiedAt" TIMESTAMPTZ(3),
  "resolutionNotes" TEXT,
  "detectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMPTZ(3),
  "reportedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "security_incidents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "processor_records" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "name" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "dataCategories" TEXT[] NOT NULL,
  "country" TEXT NOT NULL,
  "crossBorder" BOOLEAN NOT NULL DEFAULT false,
  "safeguards" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  "reviewedById" UUID,
  "reviewedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processor_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "integration_credentials_metadata" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID,
  "category" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "IntegrationStatus" NOT NULL DEFAULT 'DISABLED',
  "mode" TEXT NOT NULL DEFAULT 'TEST',
  "config" JSONB NOT NULL DEFAULT '{}',
  "secretsEnc" TEXT,
  "secretKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "secretsUpdatedAt" TIMESTAMPTZ(3),
  "authorisationNote" TEXT,
  "authorisationVerifiedById" UUID,
  "authorisationVerifiedAt" TIMESTAMPTZ(3),
  "lastTestedAt" TIMESTAMPTZ(3),
  "lastTestOk" BOOLEAN,
  "lastTestMessage" TEXT,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_credentials_metadata_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "integration_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "integrationId" UUID,
  "category" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "direction" TEXT NOT NULL DEFAULT 'OUTBOUND',
  "success" BOOLEAN NOT NULL,
  "statusCode" INTEGER,
  "durationMs" INTEGER,
  "request" JSONB,
  "response" JSONB,
  "error" TEXT,
  "relatedType" TEXT,
  "relatedId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "integration_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");
CREATE UNIQUE INDEX "sessions_refreshTokenHash_key" ON "sessions"("refreshTokenHash");
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");
CREATE INDEX "sessions_familyId_idx" ON "sessions"("familyId");
CREATE INDEX "auth_tokens_type_tokenHash_idx" ON "auth_tokens"("type", "tokenHash");
CREATE INDEX "auth_tokens_type_target_idx" ON "auth_tokens"("type", "target");
CREATE INDEX "auth_tokens_userId_type_idx" ON "auth_tokens"("userId", "type");
CREATE INDEX "login_activity_userId_createdAt_idx" ON "login_activity"("userId", "createdAt");
CREATE INDEX "login_activity_email_createdAt_idx" ON "login_activity"("email", "createdAt");
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");
CREATE INDEX "tenants_status_idx" ON "tenants"("status");
CREATE UNIQUE INDEX "roles_tenantId_key_key" ON "roles"("tenantId", "key");
CREATE INDEX "role_permissions_tenantId_idx" ON "role_permissions"("tenantId");
CREATE UNIQUE INDEX "role_permissions_roleId_permissionKey_key" ON "role_permissions"("roleId", "permissionKey");
CREATE INDEX "tenant_memberships_userId_idx" ON "tenant_memberships"("userId");
CREATE INDEX "tenant_memberships_tenantId_kind_status_idx" ON "tenant_memberships"("tenantId", "kind", "status");
CREATE UNIQUE INDEX "tenant_memberships_tenantId_userId_kind_key" ON "tenant_memberships"("tenantId", "userId", "kind");
CREATE INDEX "membership_branches_tenantId_branchId_idx" ON "membership_branches"("tenantId", "branchId");
CREATE UNIQUE INDEX "membership_branches_membershipId_branchId_key" ON "membership_branches"("membershipId", "branchId");
CREATE INDEX "staff_schedules_tenantId_membershipId_idx" ON "staff_schedules"("tenantId", "membershipId");
CREATE INDEX "staff_skills_tenantId_serviceId_idx" ON "staff_skills"("tenantId", "serviceId");
CREATE UNIQUE INDEX "staff_skills_membershipId_serviceId_key" ON "staff_skills"("membershipId", "serviceId");
CREATE UNIQUE INDEX "branches_tenantId_code_key" ON "branches"("tenantId", "code");
CREATE UNIQUE INDEX "subscription_plans_key_key" ON "subscription_plans"("key");
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");
CREATE UNIQUE INDEX "subscriptions_tenantId_key" ON "subscriptions"("tenantId");
CREATE INDEX "subscriptions_status_currentPeriodEnd_idx" ON "subscriptions"("status", "currentPeriodEnd");
CREATE UNIQUE INDEX "subscription_invoices_number_key" ON "subscription_invoices"("number");
CREATE INDEX "subscription_invoices_tenantId_status_idx" ON "subscription_invoices"("tenantId", "status");
CREATE INDEX "subscription_events_tenantId_createdAt_idx" ON "subscription_events"("tenantId", "createdAt");
CREATE UNIQUE INDEX "usage_records_tenantId_metric_periodKey_key" ON "usage_records"("tenantId", "metric", "periodKey");
CREATE UNIQUE INDEX "tenant_domains_domain_key" ON "tenant_domains"("domain");
CREATE INDEX "tenant_domains_tenantId_idx" ON "tenant_domains"("tenantId");
CREATE UNIQUE INDEX "branding_settings_tenantId_branchId_key" ON "branding_settings"("tenantId", "branchId");
CREATE UNIQUE INDEX "feature_flags_key_tenantId_key" ON "feature_flags"("key", "tenantId");
CREATE UNIQUE INDEX "number_sequences_tenantId_key_key" ON "number_sequences"("tenantId", "key");
CREATE INDEX "customers_tenantId_status_idx" ON "customers"("tenantId", "status");
CREATE INDEX "customers_tenantId_phone_idx" ON "customers"("tenantId", "phone");
CREATE INDEX "customers_tenantId_email_idx" ON "customers"("tenantId", "email");
CREATE INDEX "customers_tenantId_emiratesIdHash_idx" ON "customers"("tenantId", "emiratesIdHash");
CREATE INDEX "customers_tenantId_passportNoHash_idx" ON "customers"("tenantId", "passportNoHash");
CREATE INDEX "customers_tenantId_fullName_idx" ON "customers"("tenantId", "fullName");
CREATE UNIQUE INDEX "customers_tenantId_customerNo_key" ON "customers"("tenantId", "customerNo");
CREATE INDEX "customer_contacts_tenantId_customerId_idx" ON "customer_contacts"("tenantId", "customerId");
CREATE INDEX "customer_consents_tenantId_idx" ON "customer_consents"("tenantId");
CREATE UNIQUE INDEX "customer_consents_customerId_purpose_key" ON "customer_consents"("customerId", "purpose");
CREATE INDEX "customer_notes_tenantId_customerId_idx" ON "customer_notes"("tenantId", "customerId");
CREATE UNIQUE INDEX "customer_tags_tenantId_name_key" ON "customer_tags"("tenantId", "name");
CREATE INDEX "customer_tag_assignments_tenantId_tagId_idx" ON "customer_tag_assignments"("tenantId", "tagId");
CREATE UNIQUE INDEX "customer_tag_assignments_customerId_tagId_key" ON "customer_tag_assignments"("customerId", "tagId");
CREATE INDEX "corporate_accounts_tenantId_status_idx" ON "corporate_accounts"("tenantId", "status");
CREATE UNIQUE INDEX "corporate_accounts_tenantId_accountNo_key" ON "corporate_accounts"("tenantId", "accountNo");
CREATE INDEX "corporate_members_tenantId_userId_idx" ON "corporate_members"("tenantId", "userId");
CREATE UNIQUE INDEX "corporate_members_corporateAccountId_email_key" ON "corporate_members"("corporateAccountId", "email");
CREATE INDEX "corporate_employees_tenantId_corporateAccountId_idx" ON "corporate_employees"("tenantId", "corporateAccountId");
CREATE UNIQUE INDEX "corporate_employees_corporateAccountId_customerId_key" ON "corporate_employees"("corporateAccountId", "customerId");
CREATE INDEX "corporate_agreements_tenantId_corporateAccountId_idx" ON "corporate_agreements"("tenantId", "corporateAccountId");
CREATE INDEX "corporate_prices_tenantId_idx" ON "corporate_prices"("tenantId");
CREATE UNIQUE INDEX "corporate_prices_corporateAccountId_serviceId_key" ON "corporate_prices"("corporateAccountId", "serviceId");
CREATE UNIQUE INDEX "service_categories_tenantId_key_key" ON "service_categories"("tenantId", "key");
CREATE UNIQUE INDEX "document_types_tenantId_key_key" ON "document_types"("tenantId", "key");
CREATE INDEX "services_tenantId_categoryId_idx" ON "services"("tenantId", "categoryId");
CREATE INDEX "services_tenantId_isActive_isPublic_idx" ON "services"("tenantId", "isActive", "isPublic");
CREATE UNIQUE INDEX "services_tenantId_code_key" ON "services"("tenantId", "code");
CREATE INDEX "service_branches_tenantId_branchId_idx" ON "service_branches"("tenantId", "branchId");
CREATE UNIQUE INDEX "service_branches_serviceId_branchId_key" ON "service_branches"("serviceId", "branchId");
CREATE INDEX "service_prices_tenantId_serviceId_isActive_idx" ON "service_prices"("tenantId", "serviceId", "isActive");
CREATE INDEX "service_requirements_tenantId_serviceId_idx" ON "service_requirements"("tenantId", "serviceId");
CREATE INDEX "service_form_definitions_tenantId_serviceId_status_idx" ON "service_form_definitions"("tenantId", "serviceId", "status");
CREATE UNIQUE INDEX "service_form_definitions_serviceId_version_key" ON "service_form_definitions"("serviceId", "version");
CREATE UNIQUE INDEX "workflow_definitions_tenantId_key_key" ON "workflow_definitions"("tenantId", "key");
CREATE INDEX "workflow_versions_tenantId_definitionId_status_idx" ON "workflow_versions"("tenantId", "definitionId", "status");
CREATE UNIQUE INDEX "workflow_versions_definitionId_version_key" ON "workflow_versions"("definitionId", "version");
CREATE INDEX "workflow_steps_tenantId_versionId_position_idx" ON "workflow_steps"("tenantId", "versionId", "position");
CREATE UNIQUE INDEX "workflow_steps_versionId_key_key" ON "workflow_steps"("versionId", "key");
CREATE INDEX "service_requests_tenantId_status_idx" ON "service_requests"("tenantId", "status");
CREATE INDEX "service_requests_tenantId_branchId_status_idx" ON "service_requests"("tenantId", "branchId", "status");
CREATE INDEX "service_requests_tenantId_customerId_idx" ON "service_requests"("tenantId", "customerId");
CREATE INDEX "service_requests_tenantId_assignedToId_status_idx" ON "service_requests"("tenantId", "assignedToId", "status");
CREATE INDEX "service_requests_tenantId_corporateAccountId_idx" ON "service_requests"("tenantId", "corporateAccountId");
CREATE INDEX "service_requests_tenantId_createdAt_idx" ON "service_requests"("tenantId", "createdAt");
CREATE INDEX "service_requests_tenantId_targetDate_idx" ON "service_requests"("tenantId", "targetDate");
CREATE UNIQUE INDEX "service_requests_tenantId_requestNo_key" ON "service_requests"("tenantId", "requestNo");
CREATE INDEX "request_fields_tenantId_idx" ON "request_fields"("tenantId");
CREATE UNIQUE INDEX "request_fields_requestId_key_key" ON "request_fields"("requestId", "key");
CREATE INDEX "request_documents_tenantId_requestId_idx" ON "request_documents"("tenantId", "requestId");
CREATE INDEX "request_documents_tenantId_documentId_idx" ON "request_documents"("tenantId", "documentId");
CREATE INDEX "request_status_history_tenantId_requestId_createdAt_idx" ON "request_status_history"("tenantId", "requestId", "createdAt");
CREATE INDEX "request_assignments_tenantId_requestId_idx" ON "request_assignments"("tenantId", "requestId");
CREATE INDEX "request_assignments_tenantId_assigneeId_unassignedAt_idx" ON "request_assignments"("tenantId", "assigneeId", "unassignedAt");
CREATE INDEX "request_approvals_tenantId_requestId_idx" ON "request_approvals"("tenantId", "requestId");
CREATE INDEX "request_approvals_tenantId_status_type_idx" ON "request_approvals"("tenantId", "status", "type");
CREATE INDEX "request_comments_tenantId_requestId_createdAt_idx" ON "request_comments"("tenantId", "requestId", "createdAt");
CREATE INDEX "request_external_references_tenantId_requestId_idx" ON "request_external_references"("tenantId", "requestId");
CREATE INDEX "request_external_references_tenantId_referenceNo_idx" ON "request_external_references"("tenantId", "referenceNo");
CREATE UNIQUE INDEX "workflow_executions_requestId_key" ON "workflow_executions"("requestId");
CREATE INDEX "workflow_executions_tenantId_status_idx" ON "workflow_executions"("tenantId", "status");
CREATE INDEX "workflow_step_executions_tenantId_executionId_idx" ON "workflow_step_executions"("tenantId", "executionId");
CREATE INDEX "workflow_step_executions_status_dueAt_idx" ON "workflow_step_executions"("status", "dueAt");
CREATE INDEX "documents_tenantId_customerId_idx" ON "documents"("tenantId", "customerId");
CREATE INDEX "documents_tenantId_requestId_idx" ON "documents"("tenantId", "requestId");
CREATE INDEX "documents_tenantId_corporateAccountId_idx" ON "documents"("tenantId", "corporateAccountId");
CREATE INDEX "documents_tenantId_expiryDate_idx" ON "documents"("tenantId", "expiryDate");
CREATE INDEX "documents_tenantId_status_idx" ON "documents"("tenantId", "status");
CREATE UNIQUE INDEX "document_versions_storageKey_key" ON "document_versions"("storageKey");
CREATE INDEX "document_versions_tenantId_documentId_idx" ON "document_versions"("tenantId", "documentId");
CREATE UNIQUE INDEX "document_versions_documentId_versionNo_key" ON "document_versions"("documentId", "versionNo");
CREATE INDEX "document_access_logs_tenantId_documentId_createdAt_idx" ON "document_access_logs"("tenantId", "documentId", "createdAt");
CREATE UNIQUE INDEX "document_shares_tokenHash_key" ON "document_shares"("tokenHash");
CREATE INDEX "document_shares_tenantId_documentId_idx" ON "document_shares"("tenantId", "documentId");
CREATE INDEX "document_verification_results_tenantId_documentId_idx" ON "document_verification_results"("tenantId", "documentId");
CREATE INDEX "ocr_extraction_results_tenantId_documentId_idx" ON "ocr_extraction_results"("tenantId", "documentId");
CREATE INDEX "ocr_extraction_results_tenantId_status_idx" ON "ocr_extraction_results"("tenantId", "status");
CREATE INDEX "ai_usage_logs_tenantId_createdAt_idx" ON "ai_usage_logs"("tenantId", "createdAt");
CREATE UNIQUE INDEX "fee_components_tenantId_type_key" ON "fee_components"("tenantId", "type");
CREATE INDEX "quotations_tenantId_requestId_idx" ON "quotations"("tenantId", "requestId");
CREATE INDEX "quotations_tenantId_customerId_idx" ON "quotations"("tenantId", "customerId");
CREATE INDEX "quotations_tenantId_status_idx" ON "quotations"("tenantId", "status");
CREATE UNIQUE INDEX "quotations_tenantId_quotationNo_key" ON "quotations"("tenantId", "quotationNo");
CREATE INDEX "quotation_items_tenantId_quotationId_idx" ON "quotation_items"("tenantId", "quotationId");
CREATE INDEX "invoices_tenantId_requestId_idx" ON "invoices"("tenantId", "requestId");
CREATE INDEX "invoices_tenantId_customerId_idx" ON "invoices"("tenantId", "customerId");
CREATE INDEX "invoices_tenantId_corporateAccountId_status_idx" ON "invoices"("tenantId", "corporateAccountId", "status");
CREATE INDEX "invoices_tenantId_status_dueAt_idx" ON "invoices"("tenantId", "status", "dueAt");
CREATE INDEX "invoices_tenantId_issuedAt_idx" ON "invoices"("tenantId", "issuedAt");
CREATE UNIQUE INDEX "invoices_tenantId_invoiceNo_key" ON "invoices"("tenantId", "invoiceNo");
CREATE INDEX "invoice_items_tenantId_invoiceId_idx" ON "invoice_items"("tenantId", "invoiceId");
CREATE INDEX "payments_tenantId_customerId_idx" ON "payments"("tenantId", "customerId");
CREATE INDEX "payments_tenantId_status_receivedAt_idx" ON "payments"("tenantId", "status", "receivedAt");
CREATE INDEX "payments_tenantId_gatewaySessionRef_idx" ON "payments"("tenantId", "gatewaySessionRef");
CREATE UNIQUE INDEX "payments_tenantId_paymentNo_key" ON "payments"("tenantId", "paymentNo");
CREATE UNIQUE INDEX "payments_tenantId_idempotencyKey_key" ON "payments"("tenantId", "idempotencyKey");
CREATE UNIQUE INDEX "payments_gateway_gatewayPaymentRef_key" ON "payments"("gateway", "gatewayPaymentRef");
CREATE INDEX "payment_allocations_tenantId_paymentId_idx" ON "payment_allocations"("tenantId", "paymentId");
CREATE INDEX "payment_allocations_tenantId_invoiceId_idx" ON "payment_allocations"("tenantId", "invoiceId");
CREATE INDEX "refunds_tenantId_paymentId_idx" ON "refunds"("tenantId", "paymentId");
CREATE INDEX "refunds_tenantId_status_idx" ON "refunds"("tenantId", "status");
CREATE UNIQUE INDEX "refunds_tenantId_refundNo_key" ON "refunds"("tenantId", "refundNo");
CREATE INDEX "credit_notes_tenantId_invoiceId_idx" ON "credit_notes"("tenantId", "invoiceId");
CREATE UNIQUE INDEX "credit_notes_tenantId_creditNoteNo_key" ON "credit_notes"("tenantId", "creditNoteNo");
CREATE INDEX "expenses_tenantId_branchId_paidOn_idx" ON "expenses"("tenantId", "branchId", "paidOn");
CREATE INDEX "expenses_tenantId_category_idx" ON "expenses"("tenantId", "category");
CREATE INDEX "liability_entries_tenantId_component_occurredAt_idx" ON "liability_entries"("tenantId", "component", "occurredAt");
CREATE INDEX "liability_entries_tenantId_requestId_idx" ON "liability_entries"("tenantId", "requestId");
CREATE INDEX "reconciliation_records_tenantId_periodStart_idx" ON "reconciliation_records"("tenantId", "periodStart");
CREATE UNIQUE INDEX "payment_webhook_events_gateway_eventId_key" ON "payment_webhook_events"("gateway", "eventId");
CREATE UNIQUE INDEX "idempotency_keys_tenantId_scope_key_key" ON "idempotency_keys"("tenantId", "scope", "key");
CREATE INDEX "appointment_slot_configs_tenantId_branchId_weekday_idx" ON "appointment_slot_configs"("tenantId", "branchId", "weekday");
CREATE INDEX "branch_closures_tenantId_idx" ON "branch_closures"("tenantId");
CREATE UNIQUE INDEX "branch_closures_branchId_date_key" ON "branch_closures"("branchId", "date");
CREATE INDEX "appointments_tenantId_branchId_startsAt_idx" ON "appointments"("tenantId", "branchId", "startsAt");
CREATE INDEX "appointments_tenantId_customerId_idx" ON "appointments"("tenantId", "customerId");
CREATE INDEX "appointments_tenantId_status_startsAt_idx" ON "appointments"("tenantId", "status", "startsAt");
CREATE INDEX "queue_tokens_tenantId_branchId_queueDate_status_idx" ON "queue_tokens"("tenantId", "branchId", "queueDate", "status");
CREATE UNIQUE INDEX "queue_tokens_branchId_queueDate_tokenNo_key" ON "queue_tokens"("branchId", "queueDate", "tokenNo");
CREATE INDEX "tasks_tenantId_status_dueAt_idx" ON "tasks"("tenantId", "status", "dueAt");
CREATE INDEX "tasks_tenantId_requestId_idx" ON "tasks"("tenantId", "requestId");
CREATE INDEX "task_assignments_tenantId_taskId_idx" ON "task_assignments"("tenantId", "taskId");
CREATE INDEX "task_assignments_tenantId_assigneeId_unassignedAt_idx" ON "task_assignments"("tenantId", "assigneeId", "unassignedAt");
CREATE UNIQUE INDEX "notification_templates_tenantId_eventKey_channel_language_key" ON "notification_templates"("tenantId", "eventKey", "channel", "language");
CREATE INDEX "notifications_tenantId_recipientUserId_channel_readAt_idx" ON "notifications"("tenantId", "recipientUserId", "channel", "readAt");
CREATE INDEX "notifications_tenantId_recipientCustomerId_createdAt_idx" ON "notifications"("tenantId", "recipientCustomerId", "createdAt");
CREATE INDEX "notifications_tenantId_status_createdAt_idx" ON "notifications"("tenantId", "status", "createdAt");
CREATE UNIQUE INDEX "notifications_tenantId_dedupeKey_key" ON "notifications"("tenantId", "dedupeKey");
CREATE INDEX "notification_deliveries_tenantId_notificationId_idx" ON "notification_deliveries"("tenantId", "notificationId");
CREATE UNIQUE INDEX "notification_preferences_tenantId_userId_customerId_channel_eve" ON "notification_preferences"("tenantId", "userId", "customerId", "channel", "eventGroup");
CREATE INDEX "device_tokens_tenantId_userId_idx" ON "device_tokens"("tenantId", "userId");
CREATE UNIQUE INDEX "device_tokens_tenantId_token_key" ON "device_tokens"("tenantId", "token");
CREATE INDEX "reminder_schedules_tenantId_status_expiryDate_idx" ON "reminder_schedules"("tenantId", "status", "expiryDate");
CREATE INDEX "reminder_schedules_tenantId_customerId_idx" ON "reminder_schedules"("tenantId", "customerId");
CREATE INDEX "reminder_schedules_tenantId_documentId_idx" ON "reminder_schedules"("tenantId", "documentId");
CREATE INDEX "reminder_dispatches_tenantId_status_dueOn_idx" ON "reminder_dispatches"("tenantId", "status", "dueOn");
CREATE UNIQUE INDEX "reminder_dispatches_scheduleId_offsetDays_key" ON "reminder_dispatches"("scheduleId", "offsetDays");
CREATE UNIQUE INDEX "sla_policies_tenantId_priority_key" ON "sla_policies"("tenantId", "priority");
CREATE INDEX "support_tickets_tenantId_status_idx" ON "support_tickets"("tenantId", "status");
CREATE INDEX "support_tickets_tenantId_customerId_idx" ON "support_tickets"("tenantId", "customerId");
CREATE INDEX "support_tickets_scope_status_idx" ON "support_tickets"("scope", "status");
CREATE UNIQUE INDEX "support_tickets_tenantId_ticketNo_key" ON "support_tickets"("tenantId", "ticketNo");
CREATE INDEX "support_messages_tenantId_ticketId_createdAt_idx" ON "support_messages"("tenantId", "ticketId", "createdAt");
CREATE INDEX "customer_feedback_tenantId_createdAt_idx" ON "customer_feedback"("tenantId", "createdAt");
CREATE INDEX "outbox_events_status_availableAt_idx" ON "outbox_events"("status", "availableAt");
CREATE INDEX "outbox_events_tenantId_type_createdAt_idx" ON "outbox_events"("tenantId", "type", "createdAt");
CREATE INDEX "automation_rules_tenantId_triggerEvent_isEnabled_idx" ON "automation_rules"("tenantId", "triggerEvent", "isEnabled");
CREATE INDEX "automation_executions_tenantId_status_createdAt_idx" ON "automation_executions"("tenantId", "status", "createdAt");
CREATE UNIQUE INDEX "automation_executions_ruleId_eventId_key" ON "automation_executions"("ruleId", "eventId");
CREATE INDEX "scheduled_reports_isActive_nextRunAt_idx" ON "scheduled_reports"("isActive", "nextRunAt");
CREATE INDEX "scheduled_reports_tenantId_idx" ON "scheduled_reports"("tenantId");
CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt");
CREATE INDEX "audit_logs_tenantId_resourceType_resourceId_idx" ON "audit_logs"("tenantId", "resourceType", "resourceId");
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");
CREATE INDEX "security_events_tenantId_createdAt_idx" ON "security_events"("tenantId", "createdAt");
CREATE INDEX "security_events_type_createdAt_idx" ON "security_events"("type", "createdAt");
CREATE INDEX "access_grants_tenantId_status_idx" ON "access_grants"("tenantId", "status");
CREATE INDEX "access_grants_requestedById_status_idx" ON "access_grants"("requestedById", "status");
CREATE INDEX "consent_records_tenantId_customerId_purpose_idx" ON "consent_records"("tenantId", "customerId", "purpose");
CREATE UNIQUE INDEX "data_retention_policies_tenantId_entity_documentTypeKey_key" ON "data_retention_policies"("tenantId", "entity", "documentTypeKey");
CREATE INDEX "data_subject_requests_tenantId_status_idx" ON "data_subject_requests"("tenantId", "status");
CREATE INDEX "data_subject_requests_tenantId_customerId_idx" ON "data_subject_requests"("tenantId", "customerId");
CREATE INDEX "security_incidents_tenantId_status_idx" ON "security_incidents"("tenantId", "status");
CREATE INDEX "processor_records_tenantId_idx" ON "processor_records"("tenantId");
CREATE UNIQUE INDEX "integration_credentials_metadata_tenantId_category_provider_key" ON "integration_credentials_metadata"("tenantId", "category", "provider");
CREATE INDEX "integration_logs_tenantId_createdAt_idx" ON "integration_logs"("tenantId", "createdAt");
CREATE INDEX "integration_logs_tenantId_category_provider_idx" ON "integration_logs"("tenantId", "category", "provider");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionKey_fkey" FOREIGN KEY ("permissionKey") REFERENCES "permissions"("key") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_corporateEmployeeId_fkey" FOREIGN KEY ("corporateEmployeeId") REFERENCES "corporate_employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "membership_branches" ADD CONSTRAINT "membership_branches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "membership_branches" ADD CONSTRAINT "membership_branches_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "tenant_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "membership_branches" ADD CONSTRAINT "membership_branches_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "tenant_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_skills" ADD CONSTRAINT "staff_skills_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_skills" ADD CONSTRAINT "staff_skills_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "tenant_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_skills" ADD CONSTRAINT "staff_skills_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_pendingPlanId_fkey" FOREIGN KEY ("pendingPlanId") REFERENCES "subscription_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branding_settings" ADD CONSTRAINT "branding_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branding_settings" ADD CONSTRAINT "branding_settings_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "customers" ADD CONSTRAINT "customers_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_consents" ADD CONSTRAINT "customer_consents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_consents" ADD CONSTRAINT "customer_consents_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_tag_assignments" ADD CONSTRAINT "customer_tag_assignments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_tag_assignments" ADD CONSTRAINT "customer_tag_assignments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_tag_assignments" ADD CONSTRAINT "customer_tag_assignments_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "customer_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "corporate_accounts" ADD CONSTRAINT "corporate_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "corporate_members" ADD CONSTRAINT "corporate_members_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "corporate_members" ADD CONSTRAINT "corporate_members_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "corporate_employees" ADD CONSTRAINT "corporate_employees_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "corporate_employees" ADD CONSTRAINT "corporate_employees_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "corporate_employees" ADD CONSTRAINT "corporate_employees_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "corporate_agreements" ADD CONSTRAINT "corporate_agreements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "corporate_agreements" ADD CONSTRAINT "corporate_agreements_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "corporate_prices" ADD CONSTRAINT "corporate_prices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "corporate_prices" ADD CONSTRAINT "corporate_prices_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "corporate_prices" ADD CONSTRAINT "corporate_prices_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "services" ADD CONSTRAINT "services_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "services" ADD CONSTRAINT "services_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "services" ADD CONSTRAINT "services_workflowDefinitionId_fkey" FOREIGN KEY ("workflowDefinitionId") REFERENCES "workflow_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_branches" ADD CONSTRAINT "service_branches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_branches" ADD CONSTRAINT "service_branches_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_branches" ADD CONSTRAINT "service_branches_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_prices" ADD CONSTRAINT "service_prices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_prices" ADD CONSTRAINT "service_prices_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_prices" ADD CONSTRAINT "service_prices_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_requirements" ADD CONSTRAINT "service_requirements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_requirements" ADD CONSTRAINT "service_requirements_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_form_definitions" ADD CONSTRAINT "service_form_definitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_form_definitions" ADD CONSTRAINT "service_form_definitions_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "workflow_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "workflow_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "tenant_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "tenant_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "service_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "request_fields" ADD CONSTRAINT "request_fields_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_fields" ADD CONSTRAINT "request_fields_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_documents" ADD CONSTRAINT "request_documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_documents" ADD CONSTRAINT "request_documents_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_documents" ADD CONSTRAINT "request_documents_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "request_status_history" ADD CONSTRAINT "request_status_history_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_status_history" ADD CONSTRAINT "request_status_history_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_assignments" ADD CONSTRAINT "request_assignments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_assignments" ADD CONSTRAINT "request_assignments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_assignments" ADD CONSTRAINT "request_assignments_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "tenant_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_approvals" ADD CONSTRAINT "request_approvals_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_comments" ADD CONSTRAINT "request_comments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_comments" ADD CONSTRAINT "request_comments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_external_references" ADD CONSTRAINT "request_external_references_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "request_external_references" ADD CONSTRAINT "request_external_references_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_executions" ADD CONSTRAINT "workflow_executions_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "workflow_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "workflow_step_executions" ADD CONSTRAINT "workflow_step_executions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workflow_step_executions" ADD CONSTRAINT "workflow_step_executions_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "workflow_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_access_logs" ADD CONSTRAINT "document_access_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_verification_results" ADD CONSTRAINT "document_verification_results_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_verification_results" ADD CONSTRAINT "document_verification_results_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ocr_extraction_results" ADD CONSTRAINT "ocr_extraction_results_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ocr_extraction_results" ADD CONSTRAINT "ocr_extraction_results_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "fee_components" ADD CONSTRAINT "fee_components_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "reconciliation_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "liability_entries" ADD CONSTRAINT "liability_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reconciliation_records" ADD CONSTRAINT "reconciliation_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_slot_configs" ADD CONSTRAINT "appointment_slot_configs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointment_slot_configs" ADD CONSTRAINT "appointment_slot_configs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_closures" ADD CONSTRAINT "branch_closures_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_closures" ADD CONSTRAINT "branch_closures_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "tenant_memberships"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rescheduledFromId_fkey" FOREIGN KEY ("rescheduledFromId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "queue_tokens" ADD CONSTRAINT "queue_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "queue_tokens" ADD CONSTRAINT "queue_tokens_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "queue_tokens" ADD CONSTRAINT "queue_tokens_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "task_assignments" ADD CONSTRAINT "task_assignments_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "tenant_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reminder_schedules" ADD CONSTRAINT "reminder_schedules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reminder_schedules" ADD CONSTRAINT "reminder_schedules_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reminder_schedules" ADD CONSTRAINT "reminder_schedules_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reminder_dispatches" ADD CONSTRAINT "reminder_dispatches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reminder_dispatches" ADD CONSTRAINT "reminder_dispatches_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "reminder_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_feedback" ADD CONSTRAINT "customer_feedback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_feedback" ADD CONSTRAINT "customer_feedback_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "data_retention_policies" ADD CONSTRAINT "data_retention_policies_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "integration_credentials_metadata" ADD CONSTRAINT "integration_credentials_metadata_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "integration_logs" ADD CONSTRAINT "integration_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
