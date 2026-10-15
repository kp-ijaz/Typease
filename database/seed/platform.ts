import type { PlatformFx } from '../../services/api/src/cli/seed/fixture-types';

/** TypEase platform staff and platform-level sample records. All invented. */
export const platform: PlatformFx = {
  admin: { fullName: 'Platform Admin (demo)', email: 'admin@typease.test' },
  support: { fullName: 'Platform Support Agent (demo)', email: 'support@typease.test' },
  coupon: { code: 'DEMO20', description: 'Demo coupon: 20% off the first three months', percentOff: 20, durationMonths: 3 },
  incident: {
    title: 'Demo incident: notification emails delayed for 40 minutes',
    description: 'Sample entry for the platform incident register. No real incident happened; the record shows what the register looks like.',
    severity: 'LOW',
  },
  supportAccess: [
    {
      centre: 'al-noor',
      reason: 'Demo: the owner asked why a customer does not appear in the list. Support needs to look at the customer list.',
      scopes: ['customer.read', 'request.read.all', 'invoice.read'],
      durationMinutes: 120,
      outcome: 'USED_AND_REVOKED',
      approvedScopes: ['customer.read', 'request.read.all'],
      approvedMinutes: 30,
      decisionNote: 'Customers and requests only, half an hour is enough. (demo)',
    },
    { centre: 'gulf-star', reason: 'Demo: follow-up on the invoice numbering question. Read access to invoices is needed to check the sequence.', scopes: ['invoice.read'], durationMinutes: 60, outcome: 'PENDING' },
    { centre: 'desert-rose', reason: 'Demo: routine check of the trial set-up offered by TypEase support.', scopes: ['service.read', 'branch.read', 'document.read'], durationMinutes: 60, outcome: 'DENIED', decisionNote: 'Not needed, thank you - and we do not share documents. (demo)' },
  ],
  processors: [
    { name: 'Sample Cloud Hosting Provider (fictional)', purpose: 'Hosting of the application and its database', dataCategories: ['customer profiles', 'identity documents', 'financial records'], country: 'AE' },
    { name: 'Sample Email Delivery Service (fictional)', purpose: 'Delivery of notification emails', dataCategories: ['names', 'email addresses'], country: 'IE', safeguards: 'Demo entry: data processing agreement with standard contractual clauses.' },
  ],
};
