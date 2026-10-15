-- Double-entry accounting: chart of accounts and balanced, append-only journals. Business documents
-- (invoices, payments, refunds, credit notes, expenses, commission, till differences) post automatically.

CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

CREATE TABLE "ledger_accounts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT,
  "type" "LedgerAccountType" NOT NULL,
  "systemKey" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "journal_entries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "entryNo" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "memo" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT,
  "branchId" UUID,
  "reversalOfId" UUID,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "journal_lines" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "entryId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "memo" TEXT,
  "customerId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ledger_accounts_tenantId_code_key" ON "ledger_accounts"("tenantId", "code");
CREATE UNIQUE INDEX "ledger_accounts_tenantId_systemKey_key" ON "ledger_accounts"("tenantId", "systemKey");
CREATE INDEX "journal_entries_tenantId_date_idx" ON "journal_entries"("tenantId", "date");
CREATE INDEX "journal_entries_tenantId_sourceType_sourceId_idx" ON "journal_entries"("tenantId", "sourceType", "sourceId");
CREATE UNIQUE INDEX "journal_entries_tenantId_entryNo_key" ON "journal_entries"("tenantId", "entryNo");
CREATE INDEX "journal_lines_tenantId_accountId_idx" ON "journal_lines"("tenantId", "accountId");
CREATE INDEX "journal_lines_entryId_idx" ON "journal_lines"("entryId");

-- Every line is a debit or a credit, never both and never zero.
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_one_side" CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" > 0) <> ("credit" > 0)));
-- An automatic posting exists once per business document and kind (manual journals and expense re-postings repeat).
CREATE UNIQUE INDEX "journal_entries_source_once" ON "journal_entries"("tenantId", "sourceType", "sourceId")
  WHERE "sourceType" IN ('INVOICE_ISSUED', 'INVOICE_VOIDED', 'PAYMENT', 'REFUND', 'CREDIT_NOTE', 'COMMISSION_ACCRUED', 'COMMISSION_VOIDED', 'COMMISSION_PAID', 'CASH_VARIANCE');
-- A journal can be reversed once.
CREATE UNIQUE INDEX "journal_entries_reversed_once" ON "journal_entries"("reversalOfId") WHERE "reversalOfId" IS NOT NULL;

-- Balanced: checked at commit, after all lines of the entry are written.
CREATE OR REPLACE FUNCTION journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry uuid := COALESCE(NEW."entryId", OLD."entryId");
  d numeric; c numeric; n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "journal_entries" WHERE id = entry) THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0), COUNT(*) INTO d, c, n FROM "journal_lines" WHERE "entryId" = entry;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'journal % is not balanced (debits %, credits %, % lines)', entry, d, c, n USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_balanced();

-- Journals are never changed or deleted (only a centre's complete removal may purge them).
CREATE OR REPLACE FUNCTION journal_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF typease_purge_allowed() THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION '% rows are never changed or deleted: post a reversal instead', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
CREATE TRIGGER journal_immutability BEFORE UPDATE OR DELETE ON "journal_entries" FOR EACH ROW EXECUTE FUNCTION journal_immutability();
CREATE TRIGGER journal_immutability BEFORE UPDATE OR DELETE ON "journal_lines" FOR EACH ROW EXECUTE FUNCTION journal_immutability();

ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ledger_accounts
ALTER TABLE "ledger_accounts" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "ledger_accounts" TO typease_system;
CREATE POLICY system_access ON "ledger_accounts" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "ledger_accounts" TO typease_app;
CREATE POLICY tenant_isolation ON "ledger_accounts" FOR ALL TO typease_app USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

-- journal_entries (append-only for the application role)
ALTER TABLE "journal_entries" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "journal_entries" TO typease_system;
CREATE POLICY system_access ON "journal_entries" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON "journal_entries" TO typease_app;
CREATE POLICY tenant_isolation ON "journal_entries" FOR ALL TO typease_app USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

-- journal_lines (append-only for the application role)
ALTER TABLE "journal_lines" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "journal_lines" TO typease_system;
CREATE POLICY system_access ON "journal_lines" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON "journal_lines" TO typease_app;
CREATE POLICY tenant_isolation ON "journal_lines" FOR ALL TO typease_app USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "journal_lines" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('entryId', 'journal_entries', 'accountId', 'ledger_accounts');
