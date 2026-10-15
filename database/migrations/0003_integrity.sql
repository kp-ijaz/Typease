-- TypEase data-integrity rules that cannot be expressed in the Prisma schema:
-- null-aware uniqueness, check constraints, append-only tables and financial
-- immutability. Hand-written; reviewed with every schema change.

-- ---------------------------------------------------------------------------
-- 1. Null-aware uniqueness (PostgreSQL 15+). NULL tenantId = platform default.
-- ---------------------------------------------------------------------------
DROP INDEX "roles_tenantId_key_key";
CREATE UNIQUE INDEX "roles_tenantId_key_key" ON "roles"("tenantId", "key") NULLS NOT DISTINCT;

DROP INDEX "document_types_tenantId_key_key";
CREATE UNIQUE INDEX "document_types_tenantId_key_key" ON "document_types"("tenantId", "key") NULLS NOT DISTINCT;

DROP INDEX "notification_templates_tenantId_eventKey_channel_language_key";
CREATE UNIQUE INDEX "notification_templates_tenantId_eventKey_channel_language_key"
  ON "notification_templates"("tenantId", "eventKey", "channel", "language") NULLS NOT DISTINCT;

DROP INDEX "feature_flags_key_tenantId_key";
CREATE UNIQUE INDEX "feature_flags_key_tenantId_key" ON "feature_flags"("key", "tenantId") NULLS NOT DISTINCT;

DROP INDEX "branding_settings_tenantId_branchId_key";
CREATE UNIQUE INDEX "branding_settings_tenantId_branchId_key" ON "branding_settings"("tenantId", "branchId") NULLS NOT DISTINCT;

DROP INDEX "integration_credentials_metadata_tenantId_category_provider_key";
CREATE UNIQUE INDEX "integration_credentials_metadata_tenantId_category_provider_key"
  ON "integration_credentials_metadata"("tenantId", "category", "provider") NULLS NOT DISTINCT;

DROP INDEX "notification_preferences_tenantId_userId_customerId_channel_eve";
CREATE UNIQUE INDEX "notification_preferences_subject_channel_group_key"
  ON "notification_preferences"("tenantId", "userId", "customerId", "channel", "eventGroup") NULLS NOT DISTINCT;

DROP INDEX "data_retention_policies_tenantId_entity_documentTypeKey_key";
CREATE UNIQUE INDEX "data_retention_policies_tenantId_entity_documentTypeKey_key"
  ON "data_retention_policies"("tenantId", "entity", "documentTypeKey") NULLS NOT DISTINCT;

-- Exactly one published version at a time.
CREATE UNIQUE INDEX "workflow_versions_one_published" ON "workflow_versions"("definitionId") WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "service_form_definitions_one_published" ON "service_form_definitions"("serviceId") WHERE "status" = 'PUBLISHED';
-- One active operator and one active reviewer per request.
CREATE UNIQUE INDEX "request_assignments_one_active" ON "request_assignments"("requestId", "role") WHERE "unassignedAt" IS NULL;
-- One primary domain per tenant and app.
CREATE UNIQUE INDEX "tenant_domains_one_primary" ON "tenant_domains"("tenantId", "app") WHERE "isPrimary";
-- One head office per tenant.
CREATE UNIQUE INDEX "branches_one_head_office" ON "branches"("tenantId") WHERE "isHeadOffice";

-- Case-insensitive search helpers.
CREATE INDEX "customers_fullName_lower_idx" ON "customers"("tenantId", lower("fullName") text_pattern_ops);

-- ---------------------------------------------------------------------------
-- 2. Check constraints
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));
ALTER TABLE "users" ADD CONSTRAINT "users_phone_e164" CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_slug_format" CHECK ("slug" ~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$');
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_tax_rate_range" CHECK ("taxRatePercent" >= 0 AND "taxRatePercent" <= 100);
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_currency_iso" CHECK ("defaultCurrency" ~ '^[A-Z]{3}$');
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_lowercase_fqdn"
  CHECK ("domain" = lower("domain") AND "domain" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$');
ALTER TABLE "branding_settings" ADD CONSTRAINT "branding_hex_colours" CHECK (
  ("primaryColor" IS NULL OR "primaryColor" ~ '^#[0-9A-Fa-f]{6}$') AND
  ("secondaryColor" IS NULL OR "secondaryColor" ~ '^#[0-9A-Fa-f]{6}$') AND
  ("accentColor" IS NULL OR "accentColor" ~ '^#[0-9A-Fa-f]{6}$'));
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_weekday" CHECK ("weekday" BETWEEN 0 AND 6 AND "startTime" < "endTime");
ALTER TABLE "appointment_slot_configs" ADD CONSTRAINT "slot_configs_valid"
  CHECK ("weekday" BETWEEN 0 AND 6 AND "startTime" < "endTime" AND "slotMinutes" BETWEEN 5 AND 480 AND "capacity" >= 1);
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_time_order" CHECK ("endsAt" > "startsAt");
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_has_person" CHECK ("customerId" IS NOT NULL OR "guestName" IS NOT NULL);
ALTER TABLE "customer_feedback" ADD CONSTRAINT "customer_feedback_rating" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_period_order" CHECK ("currentPeriodEnd" > "currentPeriodStart");
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_prices" CHECK ("monthlyPrice" >= 0 AND "annualPrice" >= 0 AND "trialDays" >= 0);
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_one_kind" CHECK (
  ("percentOff" IS NOT NULL AND "amountOff" IS NULL AND "percentOff" > 0 AND "percentOff" <= 100) OR
  ("percentOff" IS NULL AND "amountOff" IS NOT NULL AND "amountOff" > 0));
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_amounts"
  CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "tax" >= 0 AND "total" >= 0 AND "total" = "subtotal" - "discount" + "tax");

ALTER TABLE "services" ADD CONSTRAINT "services_payment_policy" CHECK ("paymentPolicy" IN ('BEFORE_PROCESSING', 'AFTER_COMPLETION', 'DEPOSIT'));
ALTER TABLE "services" ADD CONSTRAINT "services_tax_mode" CHECK ("taxMode" IN ('SERVICE_FEE_ONLY', 'ALL_COMPONENTS', 'NONE'));
ALTER TABLE "services" ADD CONSTRAINT "services_deposit_percent" CHECK ("depositPercent" IS NULL OR ("depositPercent" > 0 AND "depositPercent" <= 100));
ALTER TABLE "service_prices" ADD CONSTRAINT "service_prices_non_negative"
  CHECK ("serviceFee" >= 0 AND "governmentFeeEstimate" >= 0 AND "thirdPartyFeeEstimate" >= 0 AND "currency" ~ '^[A-Z]{3}$');
ALTER TABLE "corporate_prices" ADD CONSTRAINT "corporate_prices_non_negative" CHECK ("serviceFee" >= 0);
ALTER TABLE "corporate_accounts" ADD CONSTRAINT "corporate_accounts_terms" CHECK ("paymentTermsDays" >= 0 AND ("creditLimit" IS NULL OR "creditLimit" >= 0));
ALTER TABLE "request_documents" ADD CONSTRAINT "request_documents_kind" CHECK ("kind" IN ('INPUT', 'COMPLETION'));

ALTER TABLE "quotation_items" ADD CONSTRAINT "quotation_items_amounts" CHECK (
  "quantity" > 0 AND "unitAmount" >= 0 AND "discountAmount" >= 0 AND "taxAmount" >= 0 AND "lineTotal" >= 0
  AND "taxRatePercent" >= 0 AND "taxRatePercent" <= 100);
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_amounts" CHECK (
  "quantity" > 0 AND "unitAmount" >= 0 AND "discountAmount" >= 0 AND "taxAmount" >= 0 AND "lineTotal" >= 0
  AND "taxRatePercent" >= 0 AND "taxRatePercent" <= 100);
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_totals" CHECK (
  "subtotalServiceFee" >= 0 AND "subtotalGovernmentFee" >= 0 AND "subtotalThirdParty" >= 0 AND "discountTotal" >= 0
  AND "taxTotal" >= 0 AND "total" >= 0 AND "currency" ~ '^[A-Z]{3}$'
  AND "total" = "subtotalServiceFee" + "subtotalGovernmentFee" + "subtotalThirdParty" - "discountTotal" + "taxTotal");
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_discount_approval" CHECK ("discountApproval" IN ('NONE', 'PENDING', 'APPROVED', 'REJECTED'));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_totals" CHECK (
  "subtotalServiceFee" >= 0 AND "subtotalGovernmentFee" >= 0 AND "subtotalThirdParty" >= 0 AND "discountTotal" >= 0
  AND "taxTotal" >= 0 AND "total" >= 0 AND "currency" ~ '^[A-Z]{3}$'
  AND "total" = "subtotalServiceFee" + "subtotalGovernmentFee" + "subtotalThirdParty" - "discountTotal" + "taxTotal");
-- balanceDue = total - credit notes - (payments - refunds), never negative.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_balance" CHECK (
  "amountPaid" >= 0 AND "amountCredited" >= 0 AND "amountRefunded" >= 0 AND "amountRefunded" <= "amountPaid"
  AND "balanceDue" >= 0 AND "balanceDue" = "total" - "amountCredited" - "amountPaid" + "amountRefunded");
ALTER TABLE "payments" ADD CONSTRAINT "payments_amounts" CHECK (
  "amount" > 0 AND "refundedAmount" >= 0 AND "refundedAmount" <= "amount" AND "currency" ~ '^[A-Z]{3}$');
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_fields" CHECK ("method" <> 'ONLINE_GATEWAY' OR "gateway" IS NOT NULL);
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_positive" CHECK ("amount" > 0);
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_positive" CHECK ("amount" > 0 AND "currency" ~ '^[A-Z]{3}$');
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_positive" CHECK ("amount" > 0 AND "taxAmount" >= 0 AND "status" IN ('ISSUED', 'VOID'));
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_positive" CHECK ("amount" > 0 AND "currency" ~ '^[A-Z]{3}$');
ALTER TABLE "liability_entries" ADD CONSTRAINT "liability_entries_valid" CHECK (
  "amount" > 0 AND "direction" IN ('ACCRUAL', 'REMITTANCE', 'REVERSAL') AND "component" <> 'SERVICE_FEE');
ALTER TABLE "fee_components" ADD CONSTRAINT "fee_components_service_fee_is_revenue" CHECK ("type" <> 'SERVICE_FEE' OR "treatment" = 'REVENUE');
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_size" CHECK ("sizeBytes" >= 0 AND "versionNo" >= 1);
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_limits" CHECK ("maxDownloads" >= 1 AND "downloadCount" >= 0);
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_duration" CHECK ("durationMinutes" BETWEEN 5 AND 1440 AND char_length("reason") >= 10);
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_positive" CHECK ("nextValue" >= 1);

-- ---------------------------------------------------------------------------
-- 3. Append-only tables
-- ---------------------------------------------------------------------------
-- UPDATE / DELETE are rejected. The only exception is the controlled purge path
-- (tenant offboarding, retention jobs) which runs on the system connection and
-- sets typease.allow_purge for a single transaction. The tenant-scoped role can
-- never use it.
CREATE OR REPLACE FUNCTION typease_purge_allowed() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT current_setting('typease.allow_purge', true) = 'on' AND current_user <> 'typease_app' $$;

CREATE OR REPLACE FUNCTION reject_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF typease_purge_allowed() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END $$;

CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON "security_events" FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON "request_status_history" FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON "document_access_logs" FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON "consent_records" FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON "payment_allocations" FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON "liability_entries" FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------
-- 4. Financial immutability
-- ---------------------------------------------------------------------------
-- Once an invoice leaves DRAFT its commercial content is frozen. Corrections
-- are made with credit notes, never by editing or deleting.
CREATE OR REPLACE FUNCTION invoice_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF typease_purge_allowed() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'invoice % has been issued and cannot be deleted', OLD."invoiceNo" USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."status" = 'DRAFT' THEN
      RAISE EXCEPTION 'invoice % cannot return to DRAFT', OLD."invoiceNo" USING ERRCODE = '42501';
    END IF;
    IF (NEW."invoiceNo", NEW."tenantId", NEW."customerId", NEW."currency", NEW."total", NEW."subtotalServiceFee",
        NEW."subtotalGovernmentFee", NEW."subtotalThirdParty", NEW."discountTotal", NEW."taxTotal", NEW."issuedAt")
       IS DISTINCT FROM
       (OLD."invoiceNo", OLD."tenantId", OLD."customerId", OLD."currency", OLD."total", OLD."subtotalServiceFee",
        OLD."subtotalGovernmentFee", OLD."subtotalThirdParty", OLD."discountTotal", OLD."taxTotal", OLD."issuedAt") THEN
      RAISE EXCEPTION 'invoice % has been issued: amounts and parties are immutable', OLD."invoiceNo" USING ERRCODE = '42501';
    END IF;
  END IF;
  IF OLD."status" = 'VOID' AND NEW."status" <> 'VOID' THEN
    RAISE EXCEPTION 'invoice % is void', OLD."invoiceNo" USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_immutability BEFORE UPDATE OR DELETE ON "invoices" FOR EACH ROW EXECUTE FUNCTION invoice_immutability();

CREATE OR REPLACE FUNCTION line_items_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
  parent_id uuid;
BEGIN
  IF typease_purge_allowed() THEN RETURN COALESCE(NEW, OLD); END IF;
  parent_id := (to_jsonb(COALESCE(NEW, OLD)) ->> TG_ARGV[1])::uuid;
  EXECUTE format('SELECT "status"::text FROM %I WHERE id = $1', TG_ARGV[0]) INTO parent_status USING parent_id;
  IF parent_status IS NOT NULL AND parent_status <> 'DRAFT' THEN
    RAISE EXCEPTION '% lines are frozen once the document is %', TG_ARGV[0], parent_status USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER items_frozen BEFORE INSERT OR UPDATE OR DELETE ON "invoice_items"
  FOR EACH ROW EXECUTE FUNCTION line_items_frozen('invoices', 'invoiceId');
CREATE TRIGGER items_frozen BEFORE INSERT OR UPDATE OR DELETE ON "quotation_items"
  FOR EACH ROW EXECUTE FUNCTION line_items_frozen('quotations', 'quotationId');

CREATE OR REPLACE FUNCTION payment_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF typease_purge_allowed() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments are never deleted' USING ERRCODE = '42501';
  END IF;
  IF OLD."status" IN ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED') THEN
    IF (NEW."amount", NEW."currency", NEW."method", NEW."tenantId", NEW."paymentNo", NEW."customerId", NEW."receivedAt")
       IS DISTINCT FROM
       (OLD."amount", OLD."currency", OLD."method", OLD."tenantId", OLD."paymentNo", OLD."customerId", OLD."receivedAt") THEN
      RAISE EXCEPTION 'payment % is completed: amount, method and payer are immutable', OLD."paymentNo" USING ERRCODE = '42501';
    END IF;
    IF NEW."status" NOT IN ('COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED') THEN
      RAISE EXCEPTION 'payment % is completed and cannot move to %', OLD."paymentNo", NEW."status" USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_immutability BEFORE UPDATE OR DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION payment_immutability();

CREATE OR REPLACE FUNCTION amount_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF typease_purge_allowed() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  IF NEW."amount" IS DISTINCT FROM OLD."amount" OR NEW."currency" IS DISTINCT FROM OLD."currency" THEN
    RAISE EXCEPTION '% amount is immutable', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER amount_immutability BEFORE UPDATE OR DELETE ON "refunds" FOR EACH ROW EXECUTE FUNCTION amount_immutability();
CREATE TRIGGER amount_immutability BEFORE UPDATE OR DELETE ON "credit_notes" FOR EACH ROW EXECUTE FUNCTION amount_immutability();

-- A payment can never be allocated beyond its amount.
CREATE OR REPLACE FUNCTION allocation_within_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allocated numeric;
  paid numeric;
BEGIN
  SELECT "amount" INTO paid FROM "payments" WHERE id = NEW."paymentId" FOR UPDATE;
  SELECT COALESCE(sum("amount"), 0) INTO allocated FROM "payment_allocations" WHERE "paymentId" = NEW."paymentId";
  IF allocated + NEW."amount" > paid THEN
    RAISE EXCEPTION 'allocation exceeds payment amount (% + % > %)', allocated, NEW."amount", paid USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_within_payment BEFORE INSERT ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION allocation_within_payment();
