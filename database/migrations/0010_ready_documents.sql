-- Ready-made documents: salary certificates, NOCs, contracts and letters generated from the customer's data,
-- signed electronically (link or counter) and handed over. Templates are per centre (built-ins are provisioned).

CREATE TYPE "GeneratedDocumentStatus" AS ENUM ('DRAFT', 'ISSUED', 'SIGNED', 'HANDED_OVER', 'VOID');

CREATE TABLE "document_templates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT,
  "titleEn" TEXT NOT NULL,
  "titleAr" TEXT,
  "bodyEn" TEXT NOT NULL,
  "bodyAr" TEXT,
  "fields" JSONB NOT NULL DEFAULT '[]',
  "requiresSignature" BOOLEAN NOT NULL DEFAULT true,
  "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "document_templates_tenantId_key_key" ON "document_templates"("tenantId", "key");
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_kind" CHECK ("kind" IN ('SALARY_CERTIFICATE', 'NOC', 'CONTRACT', 'LETTER'));

CREATE TABLE "generated_documents" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "documentNo" TEXT NOT NULL,
  "templateId" UUID NOT NULL,
  "templateVersion" INTEGER NOT NULL,
  "customerId" UUID NOT NULL,
  "requestId" UUID,
  "branchId" UUID,
  "titleEn" TEXT NOT NULL,
  "titleAr" TEXT,
  "bodyEn" TEXT NOT NULL,
  "bodyAr" TEXT,
  "values" JSONB NOT NULL DEFAULT '{}',
  "status" "GeneratedDocumentStatus" NOT NULL DEFAULT 'DRAFT',
  "requiresSignature" BOOLEAN NOT NULL DEFAULT true,
  "contentHash" TEXT,
  "issuedAt" TIMESTAMPTZ(3),
  "signerName" TEXT,
  "signatureImage" TEXT,
  "signedAt" TIMESTAMPTZ(3),
  "signedVia" TEXT,
  "signedIp" TEXT,
  "handedOverAt" TIMESTAMPTZ(3),
  "handedOverById" UUID,
  "handedOverTo" TEXT,
  "handoverNote" TEXT,
  "voidedAt" TIMESTAMPTZ(3),
  "voidReason" TEXT,
  "createdById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generated_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "generated_documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "generated_documents_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "document_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "generated_documents_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "generated_documents_tenantId_documentNo_key" ON "generated_documents"("tenantId", "documentNo");
CREATE INDEX "generated_documents_tenantId_customerId_idx" ON "generated_documents"("tenantId", "customerId");
CREATE INDEX "generated_documents_tenantId_status_idx" ON "generated_documents"("tenantId", "status");
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_signed" CHECK ("status" NOT IN ('SIGNED', 'HANDED_OVER') OR NOT "requiresSignature" OR ("signedAt" IS NOT NULL AND "signerName" IS NOT NULL AND "signatureImage" IS NOT NULL));
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_handed_over" CHECK ("status" <> 'HANDED_OVER' OR ("handedOverAt" IS NOT NULL AND "handedOverTo" IS NOT NULL));
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_signature_size" CHECK ("signatureImage" IS NULL OR length("signatureImage") <= 400000);

-- What was issued is what is signed: the text and values never change after DRAFT, a signature is final, and
-- only drafts are ever deleted. The single exception is erasure at the data subject's request: the document is
-- voided with the fixed reason below and its personal content replaced.
CREATE OR REPLACE FUNCTION generated_document_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF typease_purge_allowed() THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'DRAFT' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'issued documents are never deleted: void them instead' USING ERRCODE = '42501';
  END IF;
  IF NEW."status" = 'VOID' AND NEW."voidReason" = 'Erased at the request of the data subject' AND NEW."customerId" = OLD."customerId" THEN RETURN NEW; END IF;
  IF OLD."status" = 'VOID' THEN RAISE EXCEPTION 'a void document is final' USING ERRCODE = '42501'; END IF;
  IF OLD."status" <> 'DRAFT' AND (NEW."bodyEn" IS DISTINCT FROM OLD."bodyEn" OR NEW."bodyAr" IS DISTINCT FROM OLD."bodyAr" OR NEW."titleEn" IS DISTINCT FROM OLD."titleEn"
     OR NEW."titleAr" IS DISTINCT FROM OLD."titleAr" OR NEW."values" IS DISTINCT FROM OLD."values" OR NEW."customerId" IS DISTINCT FROM OLD."customerId" OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash") THEN
    RAISE EXCEPTION 'an issued document is final: void it and issue a new one' USING ERRCODE = '42501';
  END IF;
  IF OLD."signedAt" IS NOT NULL AND (NEW."signatureImage" IS DISTINCT FROM OLD."signatureImage" OR NEW."signerName" IS DISTINCT FROM OLD."signerName" OR NEW."signedAt" IS DISTINCT FROM OLD."signedAt") THEN
    RAISE EXCEPTION 'a signature is final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER generated_document_immutability BEFORE UPDATE OR DELETE ON "generated_documents" FOR EACH ROW EXECUTE FUNCTION generated_document_immutability();

ALTER TABLE "document_templates" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "document_templates" TO typease_system;
CREATE POLICY system_access ON "document_templates" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON "document_templates" TO typease_app;
CREATE POLICY tenant_isolation ON "document_templates" FOR ALL TO typease_app USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());

ALTER TABLE "generated_documents" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "generated_documents" TO typease_system;
CREATE POLICY system_access ON "generated_documents" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "generated_documents" TO typease_app;
CREATE POLICY tenant_isolation ON "generated_documents" FOR ALL TO typease_app USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "generated_documents" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('templateId', 'document_templates', 'customerId', 'customers', 'requestId', 'service_requests', 'branchId', 'branches');
