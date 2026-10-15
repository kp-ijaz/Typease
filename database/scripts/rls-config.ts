/**
 * Classification of every table for row-level security and grants.
 * A new table without a tenantId MUST be classified here or generation fails.
 */
export const RLS = {
  /** Tenant-scoped connection used for all request handling. RLS always applies. */
  appRole: 'typease_app',
  /** Narrow system connection (auth, platform admin, schedulers). */
  systemRole: 'typease_system',

  /** Never reachable from a tenant-scoped connection. */
  systemOnly: [
    'sessions',
    'auth_tokens',
    'login_activity',
    'coupons',
    'platform_settings',
    'payment_webhook_events',
    'security_incidents',
    'processor_records',
  ],

  /** Tables without tenantId that tenants may read. */
  globalReadable: ['permissions', 'subscription_plans', 'authority_fees', 'authority_fee_changes'],

  /** Nullable tenantId: rows with NULL are platform defaults every tenant may read. */
  sharedReadable: ['roles', 'role_permissions', 'document_types', 'notification_templates', 'feature_flags'],

  /** INSERT + SELECT only. UPDATE / DELETE are additionally blocked by trigger. */
  appendOnly: ['audit_logs', 'request_status_history', 'document_access_logs', 'consent_records', 'security_events'],

  /** Per-table grant overrides for the tenant-scoped role. */
  grants: {
    // Billing state is changed only by the subscription service (system connection).
    subscriptions: 'SELECT',
    subscription_invoices: 'SELECT',
    subscription_events: 'SELECT',
    // A tenant may add or remove a domain; verification status is system-controlled.
    tenant_domains: 'SELECT, INSERT, DELETE',
    // Support access is requested by platform staff; the tenant decides.
    access_grants: 'SELECT, UPDATE',
    feature_flags: 'SELECT',
    // Financial records are never deleted.
    invoices: 'SELECT, INSERT, UPDATE',
    invoice_items: 'SELECT, INSERT, UPDATE, DELETE',
    payments: 'SELECT, INSERT, UPDATE',
    payment_allocations: 'SELECT, INSERT',
    refunds: 'SELECT, INSERT, UPDATE',
    credit_notes: 'SELECT, INSERT, UPDATE',
    liability_entries: 'SELECT, INSERT',
    ai_usage_logs: 'SELECT, INSERT',
    integration_logs: 'SELECT, INSERT',
    // Tenant transactions append domain events; only the dispatcher (system) updates them.
    outbox_events: 'SELECT, INSERT',
  } as Record<string, string>,

  /** users columns visible to tenant-scoped queries (no credentials). */
  userSafeColumns: [
    'id',
    'email',
    'emailVerifiedAt',
    'phone',
    'phoneVerifiedAt',
    'fullName',
    'preferredLanguage',
    'platformRole',
    'status',
    'mfaEnabled',
    'lastLoginAt',
    'createdAt',
    'updatedAt',
    'deletedAt',
  ],

  /** tenants columns a tenant owner may change. Status etc. is platform-controlled. */
  tenantSelfUpdatableColumns: [
    'name',
    'legalName',
    'emirate',
    'timezone',
    'defaultLanguage',
    'contactEmail',
    'contactPhone',
    'tradeLicenceNo',
    'taxRegistrationNo',
    'taxRatePercent',
    'aiEnabled',
    'onboardingStep',
    'onboardingData',
    'settings',
    'updatedAt',
  ],
};
