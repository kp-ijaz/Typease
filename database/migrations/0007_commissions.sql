-- Staff commission: rules per service (or a default for all services) and the commission each person earns
-- when a request is completed. Reopening voids what was not paid out yet; paid entries are final.

CREATE TYPE "CommissionBeneficiary" AS ENUM ('OPERATOR', 'REVIEWER', 'CREATOR');
CREATE TYPE "CommissionKind" AS ENUM ('PERCENT', 'FIXED');
CREATE TYPE "CommissionEntryStatus" AS ENUM ('ACCRUED', 'PAID', 'VOID');

CREATE TABLE "commission_rules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "serviceId" UUID,
  "beneficiary" "CommissionBeneficiary" NOT NULL,
  "kind" "CommissionKind" NOT NULL,
  "value" DECIMAL(10,2) NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commission_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "commission_entries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "ruleId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "serviceId" UUID NOT NULL,
  "membershipId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "beneficiary" "CommissionBeneficiary" NOT NULL,
  "basis" DECIMAL(14,2) NOT NULL,
  "kind" "CommissionKind" NOT NULL,
  "value" DECIMAL(10,2) NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "status" "CommissionEntryStatus" NOT NULL DEFAULT 'ACCRUED',
  "earnedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMPTZ(3),
  "paidById" UUID,
  "payoutRef" TEXT,
  "voidedAt" TIMESTAMPTZ(3),
  "voidReason" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commission_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "commission_rules_tenantId_serviceId_idx" ON "commission_rules"("tenantId", "serviceId");
CREATE INDEX "commission_entries_tenantId_membershipId_status_idx" ON "commission_entries"("tenantId", "membershipId", "status");
CREATE INDEX "commission_entries_tenantId_requestId_idx" ON "commission_entries"("tenantId", "requestId");
CREATE INDEX "commission_entries_tenantId_earnedAt_idx" ON "commission_entries"("tenantId", "earnedAt");
-- One active rule per service (or default) and beneficiary.
CREATE UNIQUE INDEX "commission_rules_one_active" ON "commission_rules"("tenantId", COALESCE("serviceId", '00000000-0000-0000-0000-000000000000'::uuid), "beneficiary") WHERE "isActive";
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_value_check" CHECK ("value" >= 0 AND ("kind" <> 'PERCENT' OR "value" <= 100));
-- Earned once per request, rule and person (a voided entry may be earned again after re-completion).
CREATE UNIQUE INDEX "commission_entries_once" ON "commission_entries"("requestId", "ruleId", "membershipId") WHERE "status" <> 'VOID';
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_amount_check" CHECK ("amount" >= 0 AND "basis" >= 0);

-- A paid entry is final: its amount and person never change and it cannot be voided or un-paid.
CREATE OR REPLACE FUNCTION commission_paid_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF typease_purge_allowed() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'PAID' THEN RAISE EXCEPTION 'paid commission entries are never deleted' USING ERRCODE = '42501'; END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'PAID' AND (NEW."status" <> 'PAID' OR NEW."amount" IS DISTINCT FROM OLD."amount" OR NEW."membershipId" IS DISTINCT FROM OLD."membershipId") THEN
    RAISE EXCEPTION 'commission entry % has been paid out and is final', OLD."id" USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commission_paid_immutability BEFORE UPDATE OR DELETE ON "commission_entries" FOR EACH ROW EXECUTE FUNCTION commission_paid_immutability();

ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "commission_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "service_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "tenant_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- commission_rules
ALTER TABLE "commission_rules" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "commission_rules" TO typease_system;
CREATE POLICY system_access ON "commission_rules" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "commission_rules" TO typease_app;
CREATE POLICY tenant_isolation ON "commission_rules" FOR ALL TO typease_app USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "commission_rules" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('serviceId', 'services');

-- commission_entries
ALTER TABLE "commission_entries" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "commission_entries" TO typease_system;
CREATE POLICY system_access ON "commission_entries" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "commission_entries" TO typease_app;
CREATE POLICY tenant_isolation ON "commission_entries" FOR ALL TO typease_app USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "commission_entries" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('ruleId', 'commission_rules', 'requestId', 'service_requests', 'membershipId', 'tenant_memberships');
