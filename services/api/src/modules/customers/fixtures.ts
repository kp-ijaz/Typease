import { TenantFixture, TestApp, uniq } from '../../../test/helpers';

/** Test fixtures for the customers module. Rows of other modules are created directly (their APIs may not exist yet). */

const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
export const uniqueEmiratesId = () => `784${digits(12)}`;
export const uniquePassport = () => `P${digits(8)}`;
export const uniquePhone = () => `+9715${digits(8)}`;

export function customerBody(over: Record<string, unknown> = {}) {
  const id = uniq();
  return { fullName: `Customer ${id}`, email: `c-${id}@example.test`, phone: uniquePhone(), ...over };
}

export async function createCustomer(t: TestApp, tenant: TenantFixture, over: Record<string, unknown> = {}) {
  const res = await t.as(tenant.owner).post('/customers', customerBody(over));
  if (res.status !== 201) throw new Error(`createCustomer failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; customerNo: string; fullName: string; email: string | null; phone: string | null; version: number; [k: string]: any };
}

export async function seedService(t: TestApp, tenant: TenantFixture) {
  const category = await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: tenant.id, key: 'typing' } });
  return t.sys.service.create({ data: { tenantId: tenant.id, categoryId: category.id, code: `SVC-${uniq()}`.toUpperCase().slice(0, 30), name: 'Typing service' } });
}

export async function seedRequest(t: TestApp, tenant: TenantFixture, customerId: string, over: Record<string, unknown> = {}) {
  const service = (over.serviceId as string | undefined) ?? (await seedService(t, tenant)).id;
  return t.sys.serviceRequest.create({
    data: { tenantId: tenant.id, branchId: tenant.headOfficeId, requestNo: `TE-${digits(6)}`, customerId, serviceId: service, status: 'IN_PREPARATION', ...over } as any,
  });
}

export function seedInvoice(t: TestApp, tenant: TenantFixture, customerId: string, status: 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' = 'ISSUED', amount = '100.00', paid = '0.00') {
  const balance = (Number(amount) - Number(paid)).toFixed(2);
  return t.sys.invoice.create({
    data: {
      tenantId: tenant.id, branchId: tenant.headOfficeId, invoiceNo: `INV-${digits(6)}`, customerId, status,
      subtotalServiceFee: amount, total: amount, amountPaid: paid, balanceDue: balance, issuedAt: status === 'DRAFT' ? null : new Date(),
    },
  });
}

export function seedPayment(t: TestApp, tenant: TenantFixture, customerId: string, status: 'PENDING' | 'COMPLETED' = 'COMPLETED', amount = '50.00') {
  return t.sys.payment.create({
    data: { tenantId: tenant.id, branchId: tenant.headOfficeId, paymentNo: `PAY-${digits(6)}`, customerId, method: 'CASH', status, amount, receivedAt: status === 'COMPLETED' ? new Date() : null },
  });
}

/** One row in every table that hangs off a customer, so a merge has something to move everywhere. */
export async function seedEverything(t: TestApp, tenant: TenantFixture, customerId: string) {
  const request = await seedRequest(t, tenant, customerId);
  const tomorrow = new Date(Date.now() + 86400_000);
  const base = { tenantId: tenant.id, customerId };
  const [document, quotation, draftInvoice, issuedInvoice, pendingPayment, completedPayment, appointment, queueToken, reminder, ticket, feedback, dataRequest, task, notification] = await Promise.all([
    t.sys.document.create({ data: { ...base, documentTypeKey: 'passport', title: 'Passport copy', status: 'AVAILABLE' } }),
    t.sys.quotation.create({ data: { ...base, branchId: tenant.headOfficeId, quotationNo: `QUO-${digits(6)}`, requestId: request.id } }),
    seedInvoice(t, tenant, customerId, 'DRAFT'),
    seedInvoice(t, tenant, customerId, 'ISSUED', '300.00', '0.00'),
    seedPayment(t, tenant, customerId, 'PENDING'),
    seedPayment(t, tenant, customerId, 'COMPLETED'),
    t.sys.appointment.create({ data: { ...base, branchId: tenant.headOfficeId, startsAt: tomorrow, endsAt: new Date(tomorrow.getTime() + 1800_000) } }),
    t.sys.queueToken.create({ data: { ...base, branchId: tenant.headOfficeId, queueDate: new Date(), tokenNo: `A${digits(5)}` } }),
    t.sys.reminderSchedule.create({ data: { ...base, documentTypeKey: 'passport', subjectLabel: 'Passport', expiryDate: new Date(Date.now() + 90 * 86400_000) } }),
    t.sys.supportTicket.create({ data: { ...base, ticketNo: `TKT-${digits(6)}`, subject: 'Where is my document?' } }),
    t.sys.customerFeedback.create({ data: { ...base, rating: 5, comment: 'Quick service' } }),
    t.sys.dataSubjectRequest.create({ data: { ...base, type: 'ACCESS' } }),
    t.sys.task.create({ data: { ...base, title: 'Call the customer back' } }),
    t.sys.notification.create({ data: { tenantId: tenant.id, recipientCustomerId: customerId, eventKey: 'request.created', channel: 'IN_APP', body: 'Your request was received.' } }),
  ]);
  return { request, document, quotation, draftInvoice, issuedInvoice, pendingPayment, completedPayment, appointment, queueToken, reminder, ticket, feedback, dataRequest, task, notification };
}
