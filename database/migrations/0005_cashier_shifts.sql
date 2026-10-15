-- Cashier shifts and day-end closing. A shift is a cashier's till session: opened with a float,
-- closed with a count; counter payments, cash refunds and cash expenses taken while it is open
-- are linked to it, so the expected cash in the drawer is exact.

CREATE TYPE "CashierShiftStatus" AS ENUM ('OPEN', 'CLOSED', 'REVIEWED');

CREATE TABLE "cashier_shifts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "shiftNo" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "status" "CashierShiftStatus" NOT NULL DEFAULT 'OPEN',
  "openedById" UUID NOT NULL,
  "openedByName" TEXT NOT NULL,
  "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openingFloat" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "openingNote" TEXT,
  "closedById" UUID,
  "closedAt" TIMESTAMPTZ(3),
  "expected" JSONB,
  "countedCash" DECIMAL(14,2),
  "countedCard" DECIMAL(14,2),
  "cashVariance" DECIMAL(14,2),
  "cardVariance" DECIMAL(14,2),
  "denominations" JSONB,
  "closingNote" TEXT,
  "reviewedById" UUID,
  "reviewedAt" TIMESTAMPTZ(3),
  "reviewNote" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cashier_shifts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cashier_shifts_tenantId_branchId_openedAt_idx" ON "cashier_shifts"("tenantId", "branchId", "openedAt");
CREATE INDEX "cashier_shifts_tenantId_status_idx" ON "cashier_shifts"("tenantId", "status");
CREATE UNIQUE INDEX "cashier_shifts_tenantId_shiftNo_key" ON "cashier_shifts"("tenantId", "shiftNo");
-- One open shift per person at a time.
CREATE UNIQUE INDEX "cashier_shifts_one_open_per_person" ON "cashier_shifts"("tenantId", "openedById") WHERE "status" = 'OPEN';
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_float_check" CHECK ("openingFloat" >= 0);
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_counts_check" CHECK (("countedCash" IS NULL OR "countedCash" >= 0) AND ("countedCard" IS NULL OR "countedCard" >= 0));
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_closed_check" CHECK ("status" = 'OPEN' OR ("closedAt" IS NOT NULL AND "countedCash" IS NOT NULL));

ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments" ADD COLUMN "shiftId" UUID;
ALTER TABLE "refunds" ADD COLUMN "shiftId" UUID;
ALTER TABLE "expenses" ADD COLUMN "shiftId" UUID;
ALTER TABLE "payments" ADD CONSTRAINT "payments_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "cashier_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "cashier_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "cashier_shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "payments_shiftId_idx" ON "payments"("shiftId");
CREATE INDEX "refunds_shiftId_idx" ON "refunds"("shiftId");
CREATE INDEX "expenses_shiftId_idx" ON "expenses"("shiftId");

-- The cross-centre guards of the three tables now also cover shiftId.
DROP TRIGGER same_tenant_guard ON "payments";
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "payments" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('branchId', 'branches', 'customerId', 'customers', 'reconciliationId', 'reconciliation_records', 'shiftId', 'cashier_shifts');
DROP TRIGGER same_tenant_guard ON "refunds";
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "refunds" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('paymentId', 'payments', 'invoiceId', 'invoices', 'shiftId', 'cashier_shifts');
DROP TRIGGER same_tenant_guard ON "expenses";
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "expenses" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('branchId', 'branches', 'shiftId', 'cashier_shifts');

-- cashier_shifts
ALTER TABLE "cashier_shifts" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "cashier_shifts" TO typease_system;
CREATE POLICY system_access ON "cashier_shifts" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "cashier_shifts" TO typease_app;
CREATE POLICY tenant_isolation ON "cashier_shifts" FOR ALL TO typease_app USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "cashier_shifts" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('branchId', 'branches');
