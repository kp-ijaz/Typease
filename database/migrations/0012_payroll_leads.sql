-- Payroll (pay set-up per staff member, monthly runs with payslips, WPS file, books) and CRM leads (pipeline,
-- follow-ups, activity log, conversion to customer and request).

CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID');
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUOTED', 'WON', 'LOST');

CREATE TABLE "staff_pay" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "basicSalary" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "housingAllowance" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "transportAllowance" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "otherAllowance" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "payMethod" TEXT NOT NULL DEFAULT 'WPS',
  "employeeWpsId" TEXT,
  "bankRoutingCode" TEXT,
  "ibanEnc" TEXT,
  "ibanLast4" TEXT,
  "includeCommission" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_pay_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "staff_pay_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "staff_pay_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "tenant_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "staff_pay_tenantId_membershipId_key" ON "staff_pay"("tenantId", "membershipId");
ALTER TABLE "staff_pay" ADD CONSTRAINT "staff_pay_amounts" CHECK ("basicSalary" >= 0 AND "housingAllowance" >= 0 AND "transportAllowance" >= 0 AND "otherAllowance" >= 0);
ALTER TABLE "staff_pay" ADD CONSTRAINT "staff_pay_method" CHECK ("payMethod" IN ('WPS', 'BANK', 'CASH'));

CREATE TABLE "payroll_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "runNo" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "totalGross" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "totalDeductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "totalNet" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "notes" TEXT,
  "createdById" UUID,
  "approvedById" UUID,
  "approvedAt" TIMESTAMPTZ(3),
  "paidById" UUID,
  "paidAt" TIMESTAMPTZ(3),
  "paymentReference" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payroll_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "payroll_runs_tenantId_runNo_key" ON "payroll_runs"("tenantId", "runNo");
CREATE UNIQUE INDEX "payroll_runs_tenantId_period_key" ON "payroll_runs"("tenantId", "period");
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_period" CHECK ("period" ~ '^\d{4}-(0[1-9]|1[0-2])$');

CREATE TABLE "payroll_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "staffName" TEXT NOT NULL,
  "jobTitle" TEXT,
  "payMethod" TEXT NOT NULL,
  "daysWorked" INTEGER NOT NULL,
  "daysInPeriod" INTEGER NOT NULL,
  "basicSalary" DECIMAL(14,2) NOT NULL,
  "allowances" DECIMAL(14,2) NOT NULL,
  "overtime" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "commission" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "deductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "deductionNote" TEXT,
  "gross" DECIMAL(14,2) NOT NULL,
  "net" DECIMAL(14,2) NOT NULL,
  "commissionEntryIds" UUID[] NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payroll_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "payroll_lines_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "payroll_lines_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "tenant_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "payroll_lines_runId_membershipId_key" ON "payroll_lines"("runId", "membershipId");
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_amounts" CHECK ("overtime" >= 0 AND "commission" >= 0 AND "deductions" >= 0 AND "net" >= 0 AND "net" = "gross" - "deductions" AND "daysWorked" BETWEEN 0 AND "daysInPeriod");

-- A paid run is final: its lines and totals never change and it is never deleted.
CREATE OR REPLACE FUNCTION payroll_paid_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_status "PayrollRunStatus";
BEGIN
  IF typease_purge_allowed() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_TABLE_NAME = 'payroll_runs' THEN
    IF OLD."status" = 'PAID' THEN RAISE EXCEPTION 'payroll run % is paid and final', OLD."runNo" USING ERRCODE = '42501'; END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT "status" INTO run_status FROM "payroll_runs" WHERE "id" = COALESCE(NEW."runId", OLD."runId");
  IF run_status <> 'DRAFT' THEN RAISE EXCEPTION 'payroll lines change only while the run is a draft' USING ERRCODE = '42501'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER payroll_paid_immutability BEFORE UPDATE OR DELETE ON "payroll_runs" FOR EACH ROW EXECUTE FUNCTION payroll_paid_immutability();
CREATE TRIGGER payroll_paid_immutability BEFORE INSERT OR UPDATE OR DELETE ON "payroll_lines" FOR EACH ROW EXECUTE FUNCTION payroll_paid_immutability();

CREATE TABLE "leads" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "leadNo" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT,
  "source" TEXT NOT NULL DEFAULT 'WALK_IN',
  "serviceId" UUID,
  "interest" TEXT,
  "estimatedValue" DECIMAL(14,2),
  "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
  "lostReason" TEXT,
  "ownerId" UUID,
  "nextFollowUpAt" TIMESTAMPTZ(3),
  "customerId" UUID,
  "requestId" UUID,
  "conversationId" UUID,
  "createdById" UUID,
  "wonAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "leads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "leads_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "leads_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "leads_tenantId_leadNo_key" ON "leads"("tenantId", "leadNo");
CREATE INDEX "leads_tenantId_status_nextFollowUpAt_idx" ON "leads"("tenantId", "status", "nextFollowUpAt");
ALTER TABLE "leads" ADD CONSTRAINT "leads_source" CHECK ("source" IN ('WALK_IN', 'PHONE', 'WHATSAPP', 'WEBSITE', 'REFERRAL', 'CORPORATE', 'SOCIAL', 'OTHER'));
ALTER TABLE "leads" ADD CONSTRAINT "leads_lost_reason" CHECK ("status" <> 'LOST' OR "lostReason" IS NOT NULL);
ALTER TABLE "leads" ADD CONSTRAINT "leads_contact" CHECK ("phone" IS NOT NULL OR "email" IS NOT NULL);

CREATE TABLE "lead_activities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "leadId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_activities_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "lead_activities_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "lead_activities_tenantId_leadId_createdAt_idx" ON "lead_activities"("tenantId", "leadId", "createdAt");
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_kind" CHECK ("kind" IN ('NOTE', 'CALL', 'WHATSAPP', 'EMAIL', 'MEETING', 'STATUS'));

-- Row-level security: tenant tables
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_pay', 'payroll_runs', 'payroll_lines', 'leads', 'lead_activities'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO typease_system', t);
    EXECUTE format('CREATE POLICY system_access ON %I FOR ALL TO typease_system USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO typease_app', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO typease_app USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id())', t);
  END LOOP;
END $$;
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "staff_pay" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('membershipId', 'tenant_memberships');
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "payroll_lines" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('runId', 'payroll_runs', 'membershipId', 'tenant_memberships');
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "leads" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('serviceId', 'services', 'ownerId', 'tenant_memberships', 'customerId', 'customers', 'requestId', 'service_requests', 'conversationId', 'wa_conversations');
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "lead_activities" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('leadId', 'leads');
