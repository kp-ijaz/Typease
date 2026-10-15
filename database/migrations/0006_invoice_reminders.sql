-- Automatic payment reminders for unpaid invoices: each stage (days from the due date) is sent once;
-- staff can send one by hand or pause them until a promised payment date.

ALTER TABLE "invoices" ADD COLUMN "remindersPausedUntil" DATE;

CREATE TABLE "invoice_reminders" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "stage" INTEGER,
  "daysOverdue" INTEGER NOT NULL,
  "automatic" BOOLEAN NOT NULL DEFAULT true,
  "amount" DECIMAL(14,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'AED',
  "sentById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoice_reminders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoice_reminders_tenantId_invoiceId_idx" ON "invoice_reminders"("tenantId", "invoiceId");
CREATE INDEX "invoice_reminders_tenantId_createdAt_idx" ON "invoice_reminders"("tenantId", "createdAt");
-- An automatic stage is sent once per invoice.
CREATE UNIQUE INDEX "invoice_reminders_auto_stage_once" ON "invoice_reminders"("invoiceId", "stage") WHERE "automatic";
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_stage_check" CHECK (("automatic" AND "stage" IS NOT NULL) OR (NOT "automatic" AND "stage" IS NULL));

ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- invoice_reminders
ALTER TABLE "invoice_reminders" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_reminders" TO typease_system;
CREATE POLICY system_access ON "invoice_reminders" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "invoice_reminders" TO typease_app;
CREATE POLICY tenant_isolation ON "invoice_reminders" FOR ALL TO typease_app USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "invoice_reminders" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('invoiceId', 'invoices');
