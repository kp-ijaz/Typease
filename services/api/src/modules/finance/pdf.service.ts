import { Injectable } from '@nestjs/common';
import { TenantDb } from '../../common/db/prisma.service';
import { Errors } from '../../common/errors';
import { detectMime } from '../../common/files';
import { D, DecimalInput, sum } from '../../common/pagination';
import { BrandingService, PublicAssetStore } from '../tenancy/branding.service';
import { CreditNotesService } from './credit-notes.service';
import { Component, fmt } from './finance.calc';
import { InvoicesService } from './invoices.service';
import { PaymentsService, SETTLED } from './payments.service';
import { GOVERNMENT_FEE_NOTICE, GOVERNMENT_FEE_NOTICE_AR, PdfBrand, PdfModel, PdfSection, renderPdf, THIRD_PARTY_NOTICE, THIRD_PARTY_NOTICE_AR } from './pdf.renderer';
import { QuotationsService } from './quotations.service';
import { renderStatement } from './statement.renderer';
import { StatementsService } from './statements.service';

type Line = { description: string; component: Component; quantity: DecimalInput; unitAmount: DecimalInput; discountAmount: DecimalInput; taxRatePercent: DecimalInput; taxAmount: DecimalInput; lineTotal: DecimalInput };
const SECTION: Record<Component, { title: string; titleAr: string; note?: string; noteAr?: string; subtotal: string; subtotalAr: string }> = {
  SERVICE_FEE: { title: 'Service fees', titleAr: 'رسوم الخدمة', subtotal: 'Service fees', subtotalAr: 'مجموع رسوم الخدمة' },
  GOVERNMENT_FEE: { title: 'Government fees', titleAr: 'الرسوم الحكومية', note: GOVERNMENT_FEE_NOTICE, noteAr: GOVERNMENT_FEE_NOTICE_AR, subtotal: 'Government fees', subtotalAr: 'مجموع الرسوم الحكومية' },
  THIRD_PARTY_FEE: { title: 'Third-party charges', titleAr: 'رسوم الأطراف الأخرى', note: THIRD_PARTY_NOTICE, noteAr: THIRD_PARTY_NOTICE_AR, subtotal: 'Third-party charges', subtotalAr: 'مجموع رسوم الأطراف الأخرى' },
};
/** Arabic for every label printed on the finance documents. */
const AR = {
  quotation: 'عرض سعر', taxInvoice: 'فاتورة ضريبية', invoice: 'فاتورة', receipt: 'إيصال استلام', creditNote: 'إشعار دائن',
  date: 'التاريخ', validUntil: 'صالح حتى', status: 'الحالة', request: 'الطلب', branch: 'الفرع', issued: 'تاريخ الإصدار', due: 'تاريخ الاستحقاق',
  quotationRef: 'عرض السعر', received: 'تاريخ الاستلام', payment: 'الدفعة', method: 'طريقة الدفع', invoiceRef: 'الفاتورة',
  preparedFor: 'مُعدّ لـ', billTo: 'فاتورة إلى', receivedFrom: 'استُلم من', creditTo: 'إشعار دائن إلى',
  serviceFees: 'رسوم الخدمة', governmentFees: 'الرسوم الحكومية', thirdParty: 'رسوم الأطراف الأخرى', discount: 'الخصم', vat: 'ضريبة القيمة المضافة',
  total: 'الإجمالي', credited: 'المبلغ الدائن', paid: 'المدفوع', refunded: 'منها مسترد', balanceDue: 'الرصيد المستحق', invoiceTotal: 'إجمالي الفاتورة',
  paidWithReceipt: 'المدفوع بهذا الإيصال', refundedSince: 'المسترد لاحقًا', ofWhichTax: 'منها ضريبة', totalCredited: 'إجمالي المبلغ الدائن',
  invoiceBalance: 'رصيد الفاتورة المستحق', amountReceived: 'المبلغ المستلم', reference: 'المرجع', notApplied: 'غير مخصص بعد', reason: 'السبب', originalInvoice: 'الفاتورة الأصلية',
};
/** Address JSON of customers / companies ({ line1, city, emirate, country, poBox }) as one line. */
const addressLine = (a: unknown): string | null => {
  if (!a || typeof a !== 'object') return null;
  const v = a as Record<string, string | null | undefined>;
  const parts = [v.line1, v.poBox ? `P.O. Box ${v.poBox}` : null, v.city, v.emirate, v.country].filter((x) => x && String(x).trim());
  return parts.length ? parts.join(', ') : null;
};
const date = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
const qty = (v: DecimalInput) => D(v).toString();

export interface PdfFile {
  filename: string;
  content: Buffer;
}

/**
 * PDF versions of quotations, invoices, receipts and credit notes, branded with
 * the centre's public presentation. Each method first loads the document through
 * the same service method as the JSON detail endpoint, so exactly the same
 * authorisation applies. Bilingual (English and Arabic).
 */
@Injectable()
export class FinancePdfService {
  constructor(
    private readonly db: TenantDb,
    private readonly branding: BrandingService,
    private readonly assets: PublicAssetStore,
    private readonly quotations: QuotationsService,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
    private readonly creditNotes: CreditNotesService,
    private readonly statements: StatementsService,
  ) {}

  async brand(branchId: string | null, footer: 'invoiceFooter' | 'receiptFooter'): Promise<PdfBrand> {
    const tenantId = this.db.tenantId;
    const config = await this.branding.publicConfig(tenantId, branchId);
    return this.db.tx(async (tx) => {
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: tenantId }, select: { legalName: true, taxRegistrationNo: true } });
      // The supplier address of a tax invoice: the branch that issued it (else the head office).
      const office = await tx.branch.findFirst({
        where: { tenantId, ...(branchId ? { id: branchId } : { isHeadOffice: true }) },
        select: { address: true, emirate: true },
      });
      const rows = await tx.brandingSettings.findMany({ where: { tenantId, OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])] } });
      const base = rows.find((r) => r.branchId === null);
      const branch = rows.find((r) => r.branchId !== null);
      let logo: Buffer | null = null;
      if (config.mode === 'WHITE_LABEL') {
        const key = branch?.logoAssetKey ?? base?.logoAssetKey;
        const file = key ? await this.assets.read(key) : null;
        // The PDF library embeds PNG and JPEG only.
        if (file && ['image/png', 'image/jpeg'].includes(detectMime(file) ?? '')) logo = file;
      }
      return {
        name: config.name,
        nameAr: config.nameAr ?? null,
        legalName: tenant.legalName,
        address: [office?.address, office?.emirate].filter(Boolean).join(', ') || null,
        taxRegistrationNo: tenant.taxRegistrationNo,
        colors: config.colors,
        supportEmail: config.supportEmail,
        supportPhone: config.supportPhone,
        logo,
        footer: branch?.[footer] ?? base?.[footer] ?? null,
        poweredBy: config.mode !== 'WHITE_LABEL',
      };
    });
  }

  private sections(lines: Line[]): PdfSection[] {
    const out: PdfSection[] = [];
    for (const component of ['SERVICE_FEE', 'GOVERNMENT_FEE', 'THIRD_PARTY_FEE'] as Component[]) {
      const rows = lines.filter((l) => l.component === component);
      if (!rows.length) continue;
      out.push({
        title: SECTION[component].title,
        titleAr: SECTION[component].titleAr,
        note: SECTION[component].note,
        noteAr: SECTION[component].noteAr,
        rows: rows.map((l) => ({
          description: l.description,
          quantity: qty(l.quantity),
          unitAmount: fmt(l.unitAmount),
          discount: D(l.discountAmount).gt(0) ? `-${fmt(l.discountAmount)}` : '-',
          tax: D(l.taxAmount).gt(0) ? `${fmt(l.taxAmount)} (${D(l.taxRatePercent).toString()}%)` : '-',
          total: fmt(l.lineTotal),
        })),
        subtotalLabel: `${SECTION[component].subtotal} subtotal`,
        subtotalLabelAr: SECTION[component].subtotalAr,
        subtotal: fmt(sum(rows.map((l) => D(l.quantity).mul(D(l.unitAmount)).toDecimalPlaces(2, 4)))),
      });
    }
    return out;
  }

  private headerTotals(d: { subtotalServiceFee: DecimalInput; subtotalGovernmentFee: DecimalInput; subtotalThirdParty: DecimalInput; discountTotal: DecimalInput; taxTotal: DecimalInput; total: DecimalInput }) {
    return [
      { label: 'Service fees', labelAr: AR.serviceFees, value: fmt(d.subtotalServiceFee) },
      { label: 'Government fees', labelAr: AR.governmentFees, value: fmt(d.subtotalGovernmentFee) },
      { label: 'Third-party charges', labelAr: AR.thirdParty, value: fmt(d.subtotalThirdParty) },
      { label: 'Discount', labelAr: AR.discount, value: D(d.discountTotal).gt(0) ? `-${fmt(d.discountTotal)}` : fmt(0) },
      { label: 'VAT', labelAr: AR.vat, value: fmt(d.taxTotal) },
      { label: 'Total', labelAr: AR.total, value: fmt(d.total), strong: true },
    ];
  }
  /** Bill-to lines: names in both languages, address and TRN (what a UAE tax invoice needs for a business recipient). */
  private async party(customerId: string | null | undefined, corporateAccountId: string | null | undefined): Promise<string[]> {
    const tenantId = this.db.tenantId;
    const { customer, company } = await this.db.tx(async (tx) => ({
      customer: customerId
        ? await tx.customer.findFirst({ where: { id: customerId, tenantId }, select: { fullName: true, fullNameAr: true, customerNo: true, email: true, phone: true, address: true, type: true, taxRegistrationNo: true } })
        : null,
      company: corporateAccountId
        ? await tx.corporateAccount.findFirst({ where: { id: corporateAccountId, tenantId }, select: { companyName: true, companyNameAr: true, accountNo: true, taxRegistrationNo: true, billingAddress: true } })
        : null,
    }));
    const lines: string[] = [];
    if (company) {
      lines.push(company.companyName, company.companyNameAr ?? '', addressLine(company.billingAddress) ?? '', company.taxRegistrationNo ? `TRN ${company.taxRegistrationNo}` : '', `Account ${company.accountNo}`);
    }
    if (customer) {
      lines.push(company ? `Attn: ${customer.fullName}` : customer.fullName);
      if (!company) {
        lines.push(customer.fullNameAr ?? '', addressLine(customer.address) ?? '');
        if (customer.taxRegistrationNo) lines.push(`TRN ${customer.taxRegistrationNo}`);
      }
      lines.push(`Customer ${customer.customerNo}`, customer.phone ?? '', customer.email ?? '');
    }
    return lines.filter((l) => l && l.trim());
  }

  async quotation(id: string): Promise<PdfFile> {
    const q: any = await this.quotations.get(id);
    const model: PdfModel = {
      title: 'Quotation',
      titleAr: AR.quotation,
      number: q.quotationNo,
      brand: await this.brand(q.branchId, 'invoiceFooter'),
      currency: q.currency,
      meta: [
        ['Date', date(q.sentAt ?? q.createdAt), AR.date],
        ['Valid until', date(q.validUntil), AR.validUntil],
        ['Status', q.expired ? 'EXPIRED' : q.status, AR.status],
        ...(q.request ? ([['Request', q.request.requestNo, AR.request]] as Array<[string, string, string]>) : []),
        ['Branch', q.branch.name, AR.branch],
      ],
      party: { heading: 'Prepared for', headingAr: AR.preparedFor, lines: await this.party(q.customer?.id, q.corporateAccount?.id) },
      sections: this.sections(q.quotationItems),
      totals: this.headerTotals(q),
      notes: q.notes,
      stamp: q.status === 'DRAFT' ? 'DRAFT' : ['CANCELLED', 'SUPERSEDED', 'REJECTED'].includes(q.status) ? q.status : q.expired || q.status === 'EXPIRED' ? 'EXPIRED' : null,
    };
    return { filename: `quotation-${q.quotationNo}.pdf`, content: await renderPdf(model) };
  }

  async invoice(id: string): Promise<PdfFile> {
    const inv: any = await this.invoices.get(id);
    const brand = await this.brand(inv.branchId, 'invoiceFooter');
    const netPaid = D(inv.amountPaid).minus(inv.amountRefunded);
    const model: PdfModel = {
      title: brand.taxRegistrationNo ? 'Tax invoice' : 'Invoice',
      titleAr: brand.taxRegistrationNo ? AR.taxInvoice : AR.invoice,
      number: inv.invoiceNo,
      brand,
      currency: inv.currency,
      meta: [
        ['Issued', date(inv.issuedAt), AR.issued],
        ['Due', date(inv.dueAt), AR.due],
        ['Status', inv.status.replace('_', ' '), AR.status],
        ...(inv.request ? ([['Request', inv.request.requestNo, AR.request]] as Array<[string, string, string]>) : []),
        ...(inv.quotation ? ([['Quotation', inv.quotation.quotationNo, AR.quotationRef]] as Array<[string, string, string]>) : []),
        ['Branch', inv.branch.name, AR.branch],
      ],
      party: { heading: 'Bill to', headingAr: AR.billTo, lines: await this.party(inv.customer?.id, inv.corporateAccount?.id) },
      sections: this.sections(inv.invoiceItems),
      totals: [
        ...this.headerTotals(inv),
        ...(D(inv.amountCredited).gt(0) ? [{ label: 'Credited', labelAr: AR.credited, value: `-${fmt(inv.amountCredited)}` }] : []),
        { label: 'Paid', labelAr: AR.paid, value: fmt(netPaid) },
        ...(D(inv.amountRefunded).gt(0) ? [{ label: '  of which refunded', labelAr: AR.refunded, value: fmt(inv.amountRefunded) }] : []),
        { label: 'Balance due', labelAr: AR.balanceDue, value: fmt(inv.balanceDue), strong: true },
      ],
      notes: inv.notes,
      stamp: inv.status === 'DRAFT' ? 'DRAFT' : inv.status === 'VOID' ? 'VOID' : null,
    };
    return { filename: `invoice-${inv.invoiceNo}.pdf`, content: await renderPdf(model) };
  }

  async receipt(paymentId: string): Promise<PdfFile> {
    const p: any = await this.payments.get(paymentId);
    if (!SETTLED.includes(p.status) || !p.receiptNo) {
      throw Errors.conflict('NO_RECEIPT', 'A receipt exists only for a completed payment.');
    }
    // The lines of the invoices this payment settled, grouped by fee component.
    const invoices: any[] = [];
    for (const a of p.paymentAllocations) invoices.push({ allocated: a.amount, ...(await this.invoices.get(a.invoiceId)) });
    const lines: Line[] = invoices.flatMap((inv) => inv.invoiceItems.map((l: Line) => ({ ...l, description: invoices.length > 1 ? `${inv.invoiceNo}: ${l.description}` : l.description })));
    const first = invoices[0];
    const model: PdfModel = {
      title: 'Receipt',
      titleAr: AR.receipt,
      number: p.receiptNo,
      brand: await this.brand(p.branchId, 'receiptFooter'),
      currency: p.currency,
      meta: [
        ['Received', date(p.receivedAt), AR.received],
        ['Payment', p.paymentNo, AR.payment],
        ['Method', p.method.replace('_', ' '), AR.method],
        ['Status', p.status.replace('_', ' '), AR.status],
        ['Branch', p.branch.name, AR.branch],
      ],
      party: { heading: 'Received from', headingAr: AR.receivedFrom, lines: first ? await this.party(first.customer?.id, first.corporateAccount?.id) : p.customer ? await this.party(p.customer.id, null) : ['Customer'] },
      facts: [
        ['Amount received', `${p.currency} ${fmt(p.amount)}`, AR.amountReceived],
        ...(p.reference && p.method !== 'ONLINE_GATEWAY' ? ([['Reference', p.reference, AR.reference]] as Array<[string, string, string]>) : []),
        ...invoices.map((inv) => [`Invoice ${inv.invoiceNo}`, `${p.currency} ${fmt(inv.allocated)} applied - total ${fmt(inv.total)}, balance now ${fmt(inv.balanceDue)}`, AR.invoiceRef] as [string, string, string]),
        ...(D(p.unallocatedAmount).gt(0) ? ([['Not yet applied', `${p.currency} ${p.unallocatedAmount}`, AR.notApplied]] as Array<[string, string, string]>) : []),
      ],
      sections: this.sections(lines),
      totals: [
        ...(invoices.length
          ? [
              { label: 'Service fees', labelAr: AR.serviceFees, value: fmt(sum(invoices.map((i) => i.subtotalServiceFee))) },
              { label: 'Government fees', labelAr: AR.governmentFees, value: fmt(sum(invoices.map((i) => i.subtotalGovernmentFee))) },
              { label: 'Third-party charges', labelAr: AR.thirdParty, value: fmt(sum(invoices.map((i) => i.subtotalThirdParty))) },
              { label: 'Discount', labelAr: AR.discount, value: fmt(sum(invoices.map((i) => i.discountTotal))) },
              { label: 'VAT', labelAr: AR.vat, value: fmt(sum(invoices.map((i) => i.taxTotal))) },
              { label: 'Invoice total', labelAr: AR.invoiceTotal, value: fmt(sum(invoices.map((i) => i.total))) },
            ]
          : []),
        { label: 'Paid with this receipt', labelAr: AR.paidWithReceipt, value: fmt(p.amount), strong: true },
        ...(D(p.refundedAmount).gt(0) ? [{ label: 'Refunded since', labelAr: AR.refundedSince, value: `-${fmt(p.refundedAmount)}` }] : []),
        ...(invoices.length ? [{ label: 'Balance due', labelAr: AR.balanceDue, value: fmt(sum(invoices.map((i) => i.balanceDue))), strong: true }] : []),
      ],
      stamp: null,
    };
    return { filename: `receipt-${p.receiptNo}.pdf`, content: await renderPdf(model) };
  }

  async creditNote(id: string): Promise<PdfFile> {
    const cn: any = await this.creditNotes.get(id);
    const inv: any = await this.invoices.get(cn.invoiceId);
    const b = (cn.breakdown ?? {}) as Record<string, string>;
    const model: PdfModel = {
      title: 'Credit note',
      titleAr: AR.creditNote,
      number: cn.creditNoteNo,
      brand: await this.brand(inv.branchId, 'invoiceFooter'),
      currency: cn.currency,
      meta: [
        ['Issued', date(cn.issuedAt), AR.issued],
        ['Invoice', inv.invoiceNo, AR.invoiceRef],
        ['Status', cn.status, AR.status],
        ['Branch', inv.branch.name, AR.branch],
      ],
      party: { heading: 'Credit to', headingAr: AR.creditTo, lines: await this.party(inv.customer?.id, inv.corporateAccount?.id) },
      facts: [
        ['Reason', cn.reason, AR.reason],
        ['Original invoice', `${inv.invoiceNo} - total ${cn.currency} ${fmt(inv.total)}`, AR.originalInvoice],
      ],
      sections: [],
      totals: [
        { label: 'Service fees', labelAr: AR.serviceFees, value: `-${fmt(b.SERVICE_FEE)}` },
        { label: 'Government fees', labelAr: AR.governmentFees, value: `-${fmt(b.GOVERNMENT_FEE)}` },
        { label: 'Third-party charges', labelAr: AR.thirdParty, value: `-${fmt(b.THIRD_PARTY_FEE)}` },
        { label: '  of which VAT', labelAr: AR.ofWhichTax, value: fmt(cn.taxAmount) },
        { label: 'Total credited', labelAr: AR.totalCredited, value: fmt(cn.amount), strong: true },
        { label: 'Invoice balance due', labelAr: AR.invoiceBalance, value: fmt(inv.balanceDue), strong: true },
      ],
      notes: D(b.GOVERNMENT_FEE).gt(0) ? GOVERNMENT_FEE_NOTICE : null,
      stamp: cn.status === 'VOID' ? 'VOID' : null,
    };
    return { filename: `credit-note-${cn.creditNoteNo}.pdf`, content: await renderPdf(model) };
  }

  /** Statement of account of an individual customer (staff), or of the signed-in customer. */
  async customerStatement(customerId: string | null, query: { from?: string; to?: string }): Promise<PdfFile> {
    const st = await this.statements.customerStatement(customerId, query);
    const brand = await this.brand(null, 'invoiceFooter');
    const content = await renderStatement({
      brand,
      customer: { name: st.customer.erased ? 'Erased customer' : st.customer.fullName, nameAr: st.customer.erased ? null : st.customer.fullNameAr, number: st.customer.customerNo, trn: st.customer.taxRegistrationNo },
      from: st.from,
      to: st.to,
      currency: st.currency,
      openingBalance: st.openingBalance,
      charged: st.charged,
      received: st.received,
      closingBalance: st.closingBalance,
      lines: st.lines,
      ageing: st.ageing,
    });
    return { filename: `statement-${st.customer.customerNo}-${st.to}.pdf`, content };
  }
}
