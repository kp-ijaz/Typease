import type { TenantFx } from '../../../services/api/src/cli/seed/fixture-types';

/**
 * Desert Rose Typing - the small demo tenant.
 * Starter plan, still in its free trial, one branch, owner and receptionist.
 * It shows what a brand-new centre looks like and where the plan limits are.
 * Every name, number and message below is invented.
 */
export const desertRose: TenantFx = {
  slug: 'desert-rose',
  name: 'Desert Rose Typing',
  legalName: 'Desert Rose Typing (demo sole establishment)',
  emirate: 'Ajman',
  emailDomain: 'desert-rose.test',
  planKey: 'starter',
  trialStartedDaysAgo: 5,
  taxRatePercent: 5,
  settings: { autoAssign: false },
  branding: { whiteLabel: false, businessName: 'Desert Rose Typing' },
  branches: [
    {
      code: 'AJM',
      name: 'Ajman Shop',
      nameAr: 'محل عجمان',
      address: 'Shop 2, Sample Building, Sample Street, Al Nuaimiya, Ajman (fictional address)',
      emirate: 'Ajman',
      isHeadOffice: true,
      hours: { 0: { open: '09:00', close: '21:00' }, 1: { open: '09:00', close: '21:00' }, 2: { open: '09:00', close: '21:00' }, 3: { open: '09:00', close: '21:00' }, 4: { open: '09:00', close: '21:00' }, 5: { open: '16:00', close: '21:00' }, 6: { open: '09:00', close: '21:00' } },
    },
  ],
  owner: { key: 'owner', roleKey: 'owner', fullName: 'Mona Abdulla', jobTitle: 'Owner', login: 'owner', branches: 'ALL', joinedDaysAgo: 5 },
  staff: [{ key: 'rec1', roleKey: 'receptionist', fullName: 'Carlos Reyes', jobTitle: 'Receptionist', login: 'reception', branches: 'ALL', joinedDaysAgo: 4 }],
  customers: [
    { key: 'd01', fullName: 'Nasser Al Ali', fullNameAr: 'ناصر العلي', nationality: 'AE', dateOfBirth: '1980-06-06', language: 'ar', since: 4.5, registeredBy: 'rec1', city: 'Ajman' },
    { key: 'd02', fullName: 'Shilpa Menon', nationality: 'IN', dateOfBirth: '1991-09-19', since: 4, registeredBy: 'rec1', city: 'Ajman' },
    { key: 'd03', fullName: 'Adel Mostafa', nationality: 'EG', dateOfBirth: '1986-02-22', language: 'ar', since: 3, registeredBy: 'owner', city: 'Ajman' },
    { key: 'd04', fullName: 'Liza Soriano', nationality: 'PH', dateOfBirth: '1994-12-24', since: 2.5, city: 'Ajman', portal: 'SELF' },
    { key: 'd05', fullName: 'Naeem Akhtar', nationality: 'PK', dateOfBirth: '1983-07-13', since: 1.5, registeredBy: 'rec1', city: 'Ajman', noEmail: true },
    { key: 'd06', fullName: 'Hiwot Tesfaye', nationality: 'ET', dateOfBirth: '1996-03-30', since: 0.8, registeredBy: 'rec1', city: 'Ajman' },
  ],
  requests: [
    { ref: 'dr-r01', service: 'ST-TENANCY', customer: 'd01', start: 4.4, end: 4.3, stop: 'COMPLETED', payment: { method: 'CASH' }, operator: 'owner' },
    { ref: 'dr-r02', service: 'ST-LETTER', customer: 'd02', start: 3.8, end: 3.7, stop: 'COMPLETED', payment: { method: 'CASH' }, operator: 'owner' },
    { ref: 'dr-r03', service: 'ST-VISA-TYPING', customer: 'd03', start: 2.8, end: 1, stop: 'IN_PREPARATION', payment: { method: 'CARD_POS' }, operator: 'owner' },
    { ref: 'dr-r04', service: 'ST-EID-TYPING', customer: 'd04', via: 'PORTAL', start: 2, end: 1, stop: 'AWAITING_PAYMENT', quotation: { approvedBy: 'CUSTOMER' } },
    { ref: 'dr-r05', service: 'ST-TENANCY', customer: 'd05', start: 1.2, end: 1, stop: 'UNDER_REVIEW' },
    { ref: 'dr-r06', service: 'ST-TRANSLATION', customer: 'd06', start: 0.7, end: 0.7, stop: 'SUBMITTED', documents: 'NONE' },
  ],
  expenses: [{ branch: 'AJM', category: 'SUPPLIES', description: 'Opening stock of paper and folders (demo)', amount: '650.00', paidDaysAgo: 4, method: 'CASH' }],
  appointments: [{ ref: 'dr-a01', customer: 'd04', via: 'PORTAL', branch: 'AJM', service: 'ST-EID-TYPING', day: 1, time: '17:00', outcome: 'BOOKED' }],
  tickets: [{ ref: 'dr-t01', customer: 'd04', via: 'PORTAL', subject: 'Can I pay my invoice by card at the shop?', request: 'dr-r04', openedDaysAgo: 0.9, state: 'OPEN', messages: [{ from: 'CUSTOMER', body: 'The portal shows an invoice. Can I pay by card at your shop? (demo message)', afterHours: 0 }] }],
  planLimitDemo: {
    secondBranch: { code: 'AJM2', name: 'Second Shop (not allowed on Starter)', address: 'Sample address (fictional)', emirate: 'Ajman', hours: {} },
  },
};
