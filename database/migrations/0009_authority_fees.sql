-- Authority fee catalogue maintained by TypEase: government and typing-channel fees of common transactions
-- (Amer, Tasheel, ICP, MOHRE ...). Platform-wide, read by every centre, changed only by platform staff.
-- A centre links its services to an entry and applies TypEase's updates to its prices when it chooses.

CREATE TABLE "authority_fees" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "authority" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT,
  "category" TEXT,
  "governmentFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "thirdPartyFee" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "notes" TEXT,
  "sourceUrl" TEXT,
  "verifiedAt" DATE,
  "isSample" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "authority_fees_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "authority_fees_code_key" ON "authority_fees"("code");
CREATE INDEX "authority_fees_authority_isActive_idx" ON "authority_fees"("authority", "isActive");
ALTER TABLE "authority_fees" ADD CONSTRAINT "authority_fees_amounts" CHECK ("governmentFee" >= 0 AND "thirdPartyFee" >= 0 AND "version" >= 1);

CREATE TABLE "authority_fee_changes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "feeId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "governmentFeeBefore" DECIMAL(14,2) NOT NULL,
  "governmentFeeAfter" DECIMAL(14,2) NOT NULL,
  "thirdPartyFeeBefore" DECIMAL(14,2) NOT NULL,
  "thirdPartyFeeAfter" DECIMAL(14,2) NOT NULL,
  "note" TEXT,
  "changedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "authority_fee_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "authority_fee_changes_feeId_fkey" FOREIGN KEY ("feeId") REFERENCES "authority_fees"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "authority_fee_changes_feeId_version_key" ON "authority_fee_changes"("feeId", "version");

-- A centre's service may follow one catalogue entry; authorityFeeVersion is the version last applied to its price.
ALTER TABLE "services" ADD COLUMN "authorityFeeId" UUID, ADD COLUMN "authorityFeeVersion" INTEGER;
ALTER TABLE "services" ADD CONSTRAINT "services_authorityFeeId_fkey" FOREIGN KEY ("authorityFeeId") REFERENCES "authority_fees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "services_tenantId_authorityFeeId_idx" ON "services"("tenantId", "authorityFeeId");

-- Global-readable (like subscription_plans): every centre reads, only the platform writes.
ALTER TABLE "authority_fees" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "authority_fees" TO typease_system;
CREATE POLICY system_access ON "authority_fees" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT ON "authority_fees" TO typease_app;
CREATE POLICY global_read ON "authority_fees" FOR SELECT TO typease_app USING (true);

ALTER TABLE "authority_fee_changes" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON "authority_fee_changes" TO typease_system;
CREATE POLICY system_access ON "authority_fee_changes" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT ON "authority_fee_changes" TO typease_app;
CREATE POLICY global_read ON "authority_fee_changes" FOR SELECT TO typease_app USING (true);
