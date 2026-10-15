-- WhatsApp team inbox: one conversation per customer phone number, inbound and outbound messages, internal notes,
-- assignment and status. Inbound messages arrive through the Meta webhook (signature-verified) and are de-duplicated
-- by the provider message id.

CREATE TABLE "wa_conversations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "phone" TEXT NOT NULL,
  "contactName" TEXT,
  "customerId" UUID,
  "branchId" UUID,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "assignedToId" UUID,
  "unreadCount" INTEGER NOT NULL DEFAULT 0,
  "lastMessageAt" TIMESTAMPTZ(3),
  "lastInboundAt" TIMESTAMPTZ(3),
  "lastPreview" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wa_conversations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wa_conversations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wa_conversations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "wa_conversations_tenantId_phone_key" ON "wa_conversations"("tenantId", "phone");
CREATE INDEX "wa_conversations_tenantId_status_lastMessageAt_idx" ON "wa_conversations"("tenantId", "status", "lastMessageAt");
ALTER TABLE "wa_conversations" ADD CONSTRAINT "wa_conversations_status" CHECK ("status" IN ('OPEN', 'PENDING', 'CLOSED'));
ALTER TABLE "wa_conversations" ADD CONSTRAINT "wa_conversations_phone" CHECK ("phone" ~ '^\+[1-9][0-9]{6,14}$');

CREATE TABLE "wa_messages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "direction" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'TEXT',
  "body" TEXT,
  "mediaProviderId" TEXT,
  "mediaMime" TEXT,
  "mediaName" TEXT,
  "documentId" UUID,
  "providerMessageId" TEXT,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "authorId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wa_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wa_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "wa_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "wa_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "wa_messages_tenantId_conversationId_createdAt_idx" ON "wa_messages"("tenantId", "conversationId", "createdAt");
CREATE UNIQUE INDEX "wa_messages_provider_once" ON "wa_messages"("tenantId", "providerMessageId") WHERE "providerMessageId" IS NOT NULL;
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_direction" CHECK ("direction" IN ('IN', 'OUT', 'NOTE'));
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_kind" CHECK ("kind" IN ('TEXT', 'TEMPLATE', 'IMAGE', 'DOCUMENT', 'AUDIO', 'OTHER'));
ALTER TABLE "wa_messages" ADD CONSTRAINT "wa_messages_status" CHECK ("status" IN ('RECEIVED', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'NOTE'));

ALTER TABLE "wa_conversations" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_conversations" TO typease_system;
CREATE POLICY system_access ON "wa_conversations" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_conversations" TO typease_app;
CREATE POLICY tenant_isolation ON "wa_conversations" FOR ALL TO typease_app USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "wa_conversations" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('customerId', 'customers', 'branchId', 'branches', 'assignedToId', 'tenant_memberships');

ALTER TABLE "wa_messages" ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_messages" TO typease_system;
CREATE POLICY system_access ON "wa_messages" FOR ALL TO typease_system USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "wa_messages" TO typease_app;
CREATE POLICY tenant_isolation ON "wa_messages" FOR ALL TO typease_app USING ("tenantId" = app_tenant_id()) WITH CHECK ("tenantId" = app_tenant_id());
CREATE TRIGGER same_tenant_guard BEFORE INSERT OR UPDATE ON "wa_messages" FOR EACH ROW EXECUTE FUNCTION assert_same_tenant('conversationId', 'wa_conversations', 'documentId', 'documents');
