import { randomUUID } from 'node:crypto';
import type { Actor, TenantFixture, TestApp } from '../../../test/helpers';
import { uniq } from '../../../test/helpers';

/**
 * Test fixtures for the dashboard and reports modules.
 *
 * Money is created through the REAL finance API (invoices, payments, refunds,
 * credit notes, expenses), so the figures under test come from the same code
 * paths as production data. Rows of other modules that only set the scene
 * (customers, services, requests in a given status, status history, tasks,
 * reminders, feedback) are inserted directly, as the workstream rules allow.
 */

/** UTC instant at which "today" starts in Asia/Dubai (UTC+4, no daylight saving): computed without the code under test. */
export function dubaiDayStart(offsetDays = 0, now = new Date()): Date {
  const local = new Date(now.getTime() + 4 * 3_600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + offsetDays) - 4 * 3_600_000);
}
/** "YYYY-MM-DD" of a Dubai calendar day relative to today. */
export function dubaiDay(offsetDays = 0, now = new Date()): string {
  return new Date(dubaiDayStart(offsetDays, now).getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
}

export async function addBranch(t: TestApp, tenant: TenantFixture, code = `B${uniq().slice(-5)}`.toUpperCase()) {
  const res = await t.as(tenant.owner).post('/branches', { code, name: `Branch ${code}` });
  if (res.status !== 201) throw new Error(`branch create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; code: string; name: string };
}

/** A custom staff role with exactly these permissions, and a signed-in member holding it. */
export async function addStaffWithPermissions(t: TestApp, tenant: TenantFixture, permissions: string[], opts: { branchIds?: string[] } = {}): Promise<Actor> {
  const key = `custom_${uniq().slice(-8)}`;
  const role = await t.as(tenant.owner).post('/roles', { key, name: `Custom ${key}`, permissions });
  if (role.status !== 201) throw new Error(`role create failed: ${role.status} ${JSON.stringify(role.body)}`);
  return t.addStaff(tenant, key, opts);
}

export async function seedCustomer(t: TestApp, tenant: TenantFixture, data: { fullName?: string; type?: 'INDIVIDUAL' | 'BUSINESS'; corporateAccountId?: string | null; createdAt?: Date; status?: 'ACTIVE' | 'ARCHIVED' | 'MERGED' } = {}) {
  return t.sys.customer.create({
    data: {
      tenantId: tenant.id, customerNo: `CUS-${uniq()}`.toUpperCase(), fullName: data.fullName ?? `Customer ${uniq()}`, type: data.type ?? 'INDIVIDUAL', status: data.status ?? 'ACTIVE',
      corporateAccountId: data.corporateAccountId ?? null, ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
}

export async function seedService(t: TestApp, tenant: TenantFixture, data: { name?: string; categoryKey?: string; taxMode?: 'SERVICE_FEE_ONLY' | 'ALL_COMPONENTS' | 'NONE' } = {}) {
  const category = await t.sys.serviceCategory.findFirstOrThrow({ where: { tenantId: tenant.id, key: data.categoryKey ?? 'typing' } });
  return t.sys.service.create({ data: { tenantId: tenant.id, categoryId: category.id, code: `SVC-${uniq()}`.toUpperCase().slice(0, 30), name: data.name ?? `Service ${uniq()}`, taxMode: data.taxMode ?? 'SERVICE_FEE_ONLY', requiresApproval: false } });
}

export async function seedCorporate(t: TestApp, tenant: TenantFixture, companyName = `Company ${uniq()} LLC`) {
  return t.sys.corporateAccount.create({ data: { tenantId: tenant.id, accountNo: `CORP-${uniq()}`.toUpperCase(), companyName, status: 'ACTIVE' } });
}

export interface RequestSeed {
  customerId: string;
  serviceId: string;
  branchId?: string;
  status?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  assignedToId?: string | null;
  reviewerId?: string | null;
  corporateAccountId?: string | null;
  createdAt?: Date;
  submittedAt?: Date | null;
  completedAt?: Date | null;
  targetDate?: Date | null;
  deletedAt?: Date | null;
}
/** A request row in a given state, without going through the state machine (the reports only read it). */
export async function seedRequest(t: TestApp, tenant: TenantFixture, data: RequestSeed) {
  return t.sys.serviceRequest.create({
    data: {
      tenantId: tenant.id, branchId: data.branchId ?? tenant.headOfficeId, requestNo: `TE-${uniq()}`.toUpperCase(), customerId: data.customerId, serviceId: data.serviceId,
      status: (data.status as any) ?? 'SUBMITTED', priority: data.priority ?? 'NORMAL', assignedToId: data.assignedToId ?? null, reviewerId: data.reviewerId ?? null, corporateAccountId: data.corporateAccountId ?? null,
      submittedAt: data.submittedAt === undefined ? (data.createdAt ?? new Date()) : data.submittedAt, completedAt: data.completedAt ?? null, targetDate: data.targetDate ?? null, deletedAt: data.deletedAt ?? null,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });
}

let historySeq = 0;
export function seedHistory(t: TestApp, tenant: TenantFixture, requestId: string, from: string | null, to: string, at: Date, actorId?: string | null) {
  return t.sys.requestStatusHistory.create({
    data: { tenantId: tenant.id, requestId, fromStatus: from as any, toStatus: to as any, actorId: actorId ?? null, actorType: actorId ? 'STAFF' : 'SYSTEM', createdAt: at, meta: { seq: ++historySeq } },
  });
}

export async function seedTask(t: TestApp, tenant: TenantFixture, data: { title?: string; status?: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED'; assigneeId?: string; branchId?: string | null; requestId?: string | null; dueAt?: Date | null }) {
  const task = await t.sys.task.create({ data: { tenantId: tenant.id, title: data.title ?? 'Follow up', status: data.status ?? 'OPEN', branchId: data.branchId ?? null, requestId: data.requestId ?? null, dueAt: data.dueAt ?? null } });
  if (data.assigneeId) await t.sys.taskAssignment.create({ data: { tenantId: tenant.id, taskId: task.id, assigneeId: data.assigneeId } });
  return task;
}

export function seedReminder(t: TestApp, tenant: TenantFixture, data: { customerId?: string | null; documentTypeKey?: string; subjectLabel?: string; expiryDate: string; status?: 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED'; renewalRequestId?: string | null }) {
  return t.sys.reminderSchedule.create({
    data: {
      tenantId: tenant.id, customerId: data.customerId ?? null, documentTypeKey: data.documentTypeKey ?? 'passport', subjectLabel: data.subjectLabel ?? 'Tracked document', expiryDate: new Date(`${data.expiryDate}T00:00:00.000Z`),
      status: data.status ?? 'ACTIVE', renewalRequestId: data.renewalRequestId ?? null,
    },
  });
}

// ====================================================================== finance through the real API
export const key = () => randomUUID();
export interface LineSpec {
  component: 'SERVICE_FEE' | 'GOVERNMENT_FEE' | 'THIRD_PARTY_FEE';
  unitAmount: string;
  quantity?: number;
  discountAmount?: string;
  taxRatePercent?: number;
  serviceId?: string;
  description?: string;
}
export const line = (component: LineSpec['component'], unitAmount: string, extra: Partial<LineSpec> = {}): LineSpec => ({ component, unitAmount, ...extra });

export interface IssuedInvoice {
  id: string;
  invoiceNo: string;
  total: string;
  balanceDue: string;
  status: string;
  [k: string]: any;
}
/** Draft + issue through the API. A discounted draft is created by `author` and issued by `issuer` (segregation of duties). */
export async function issueInvoice(
  t: TestApp,
  author: Actor,
  opts: { customerId: string; items: LineSpec[]; branchId?: string; requestId?: string; corporateAccountId?: string; issuer?: Actor },
): Promise<IssuedInvoice> {
  const items = opts.items.map((i) => ({ description: i.description ?? (i.component === 'SERVICE_FEE' ? 'Typing service fee' : i.component === 'GOVERNMENT_FEE' ? 'Government fee' : 'Courier charge'), quantity: 1, ...i }));
  const draft = await t.as(author).post('/invoices', { customerId: opts.customerId, branchId: opts.branchId, requestId: opts.requestId, corporateAccountId: opts.corporateAccountId, items });
  if (draft.status !== 201) throw new Error(`invoice create failed: ${draft.status} ${JSON.stringify(draft.body)}`);
  const issued = await t.as(opts.issuer ?? author).post(`/invoices/${draft.body.id}/issue`);
  if (issued.status !== 200) throw new Error(`invoice issue failed: ${issued.status} ${JSON.stringify(issued.body)}`);
  return issued.body;
}

export async function pay(t: TestApp, actor: Actor, opts: { invoiceId: string; amount: string; branchId: string; customerId?: string; method?: 'CASH' | 'CARD_POS' | 'BANK_TRANSFER' | 'CHEQUE'; receivedAt?: Date }) {
  const res = await t
    .as(actor)
    .post('/payments', { method: opts.method ?? 'CASH', amount: opts.amount, branchId: opts.branchId, customerId: opts.customerId, receivedAt: opts.receivedAt?.toISOString(), allocations: [{ invoiceId: opts.invoiceId, amount: opts.amount }] })
    .set('Idempotency-Key', key());
  if (res.status !== 201) throw new Error(`payment failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; paymentNo: string; amount: string; [k: string]: any };
}

/** Requested by one person, approved and paid out by another (the finance module refuses anything else). */
export async function refund(
  t: TestApp,
  requester: Actor,
  approver: Actor,
  opts: { paymentId: string; invoiceId?: string; amount: string; cancelCharge?: boolean; reason?: string; breakdown?: Record<string, string> },
) {
  const requested = await t
    .as(requester)
    .post('/refunds', { paymentId: opts.paymentId, invoiceId: opts.invoiceId, amount: opts.amount, reason: opts.reason ?? 'Customer changed their mind', cancelCharge: opts.cancelCharge ?? false, breakdown: opts.breakdown })
    .set('Idempotency-Key', key());
  if (requested.status !== 201) throw new Error(`refund request failed: ${requested.status} ${JSON.stringify(requested.body)}`);
  const approved = await t.as(approver).post(`/refunds/${requested.body.id}/approve`, { reference: `CASH-OUT-${uniq()}` });
  if (approved.status !== 200 && approved.status !== 201) throw new Error(`refund approve failed: ${approved.status} ${JSON.stringify(approved.body)}`);
  if (approved.body.status !== 'COMPLETED') throw new Error(`refund not completed: ${JSON.stringify(approved.body)}`);
  return approved.body as { id: string; refundNo: string; amount: string; [k: string]: any };
}

export async function creditNote(t: TestApp, actor: Actor, opts: { invoiceId: string; amount: string; breakdown?: Record<string, string>; reason?: string }) {
  const res = await t.as(actor).post('/credit-notes', { invoiceId: opts.invoiceId, amount: opts.amount, reason: opts.reason ?? 'Price correction', breakdown: opts.breakdown });
  if (res.status !== 201) throw new Error(`credit note failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; creditNoteNo: string; [k: string]: any };
}

export async function voidInvoice(t: TestApp, actor: Actor, invoiceId: string) {
  const res = await t.as(actor).post(`/invoices/${invoiceId}/void`, { reason: 'Raised by mistake' });
  if (res.status !== 200 && res.status !== 201) throw new Error(`void failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function expense(t: TestApp, actor: Actor, opts: { branchId: string; category: string; amount: string; paidOn: string; requestId?: string; description?: string }) {
  const res = await t.as(actor).post('/expenses', { branchId: opts.branchId, category: opts.category, amount: opts.amount, paidOn: opts.paidOn, requestId: opts.requestId, description: opts.description ?? `${opts.category} payment` });
  if (res.status !== 201) throw new Error(`expense failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; [k: string]: any };
}

/**
 * An invoice that was issued on an earlier day. The API always issues "now" and
 * the database forbids changing `issuedAt` afterwards, so the row is written as a
 * draft with its lines and then issued with the past date in one update - the
 * same shape the finance module produces (totals follow the same formulas).
 */
export async function seedIssuedInvoice(
  t: TestApp,
  tenant: TenantFixture,
  opts: { customerId: string; branchId?: string; requestId?: string | null; corporateAccountId?: string | null; issuedAt: Date; serviceFee: string; taxRatePercent?: number; governmentFee?: string; serviceId?: string | null },
) {
  const fee = Number(opts.serviceFee);
  const tax = Math.round(fee * (opts.taxRatePercent ?? 5)) / 100;
  const government = Number(opts.governmentFee ?? 0);
  const total = (fee + tax + government).toFixed(2);
  const invoice = await t.sys.invoice.create({
    data: {
      tenantId: tenant.id, branchId: opts.branchId ?? tenant.headOfficeId, invoiceNo: `DRAFT-${uniq()}`, requestId: opts.requestId ?? null, customerId: opts.customerId, corporateAccountId: opts.corporateAccountId ?? null,
      status: 'DRAFT', subtotalServiceFee: fee.toFixed(2), subtotalGovernmentFee: government.toFixed(2), taxTotal: tax.toFixed(2), total, balanceDue: total,
    },
  });
  await t.sys.invoiceItem.create({
    data: { tenantId: tenant.id, invoiceId: invoice.id, serviceId: opts.serviceId ?? null, description: 'Typing service fee', component: 'SERVICE_FEE', unitAmount: fee.toFixed(2), taxRatePercent: opts.taxRatePercent ?? 5, taxAmount: tax.toFixed(2), lineTotal: (fee + tax).toFixed(2) },
  });
  if (government > 0) {
    await t.sys.invoiceItem.create({ data: { tenantId: tenant.id, invoiceId: invoice.id, description: 'Government fee', component: 'GOVERNMENT_FEE', unitAmount: government.toFixed(2), lineTotal: government.toFixed(2), sortOrder: 1 } });
  }
  return t.sys.invoice.update({ where: { id: invoice.id }, data: { status: 'ISSUED', invoiceNo: `INV-OLD-${uniq()}`.toUpperCase(), issuedAt: opts.issuedAt, dueAt: opts.issuedAt } });
}
