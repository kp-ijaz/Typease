-- Role management: a company can keep its own roles in the corporate portal. Such a role belongs to the
-- centre (tenantId, so row-level security is unchanged) and to one company. Its key embeds the company id,
-- so the existing unique ("tenantId", "key") still holds.

ALTER TABLE "roles" ADD COLUMN "corporateAccountId" UUID;
ALTER TABLE "roles" ADD CONSTRAINT "roles_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_kind" CHECK ("corporateAccountId" IS NULL OR ("kind" = 'CORPORATE' AND "tenantId" IS NOT NULL));
CREATE INDEX "roles_corporateAccountId_idx" ON "roles"("corporateAccountId");
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "roles" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('corporateAccountId', 'corporate_accounts');
