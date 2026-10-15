import type { TenantFixture, TestApp } from '../../../test/helpers';
import { uniq } from '../../../test/helpers';

/** Rows of other modules' tables that the privacy tests need. Synthetic data only. */

export async function createInvoice(t: TestApp, tenant: TenantFixture, customerId: string, opts: { total?: number; paid?: number; status?: string; requestId?: string } = {}) {
  const total = opts.total ?? 150;
  const paid = opts.paid ?? 0;
  return t.sys.invoice.create({
    data: {
      tenantId: tenant.id,
      branchId: tenant.headOfficeId,
      invoiceNo: `INV-${uniq()}`,
      customerId,
      requestId: opts.requestId ?? null,
      status: (opts.status as any) ?? (paid >= total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'ISSUED'),
      subtotalServiceFee: total,
      total,
      amountPaid: paid,
      balanceDue: total - paid,
      issuedAt: new Date(),
    },
  });
}

export async function createPayment(t: TestApp, tenant: TenantFixture, customerId: string, amount = 150) {
  return t.sys.payment.create({
    data: { tenantId: tenant.id, branchId: tenant.headOfficeId, paymentNo: `PAY-${uniq()}`, receiptNo: `RCT-${uniq()}`, customerId, method: 'CASH', status: 'COMPLETED', amount, receivedAt: new Date() },
  });
}
